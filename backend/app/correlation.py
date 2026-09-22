"""Cross-correlation based pick propagation.

Given an existing pick (the *template*) on one station/channel, a symmetric
template window ``[t-u, t+u]`` is cut around that pick and linearly resampled
onto each target station's sample-rate grid.  We slide the template over a
``±max_shift`` search range (again centred on the template pick time) and
score every integer-sample lag with the **de-meaned normalised
cross-correlation**::

                  sum_k (a_k - mean(a)) (b_k - mean(b))
    ncc(l) = -----------------------------------------------
             sqrt(sum (a-mean(a))^2  * sum (b-mean(b))^2)

Ties between equal-peak lags are broken by the smaller absolute shift and
then the earlier arrival time.  Template windows or sliding windows that are
constant cannot be normalised; lags whose window would run past the trace
edges ("insufficient coverage") are skipped entirely.  Such target stations
come back as *unavailable* with an explanatory reason rather than as an
error, while a misconfigured request itself raises ``CorrelationError``.
"""
from __future__ import annotations

from typing import Any, Sequence

# Per-target / per-lag outcome codes (kept in responses for the UI).
REASON_TEMPLATE_CONSTANT = "template_constant"
REASON_CONSTANT_WINDOW = "constant_window"
REASON_NO_CHANNEL = "no_channel"
REASON_INSUFFICIENT_COVERAGE = "insufficient_coverage"
REASON_BELOW_THRESHOLD = "below_threshold"

REASON_TEXT = {
    REASON_TEMPLATE_CONSTANT: "模板窗为常量，无法归一化",
    REASON_CONSTANT_WINDOW: "搜索窗全部为常量，无法归一化",
    REASON_NO_CHANNEL: "目标台站缺少同通道波形",
    REASON_INSUFFICIENT_COVERAGE: "时移范围内波形覆盖不足",
    REASON_BELOW_THRESHOLD: "相关系数低于阈值",
}

# Guard rails for the pure-Python sliding loop.
MAX_TEMPLATE_SAMPLES = 4096
MAX_LAG_SAMPLES = 20000
# Below this relative energy a window is treated as constant.
ENERGY_EPS = 1e-12
# Peak coefficients within this tolerance count as equal (tie-break rules).
PEAK_EPS = 1e-9


class CorrelationError(ValueError):
    """The propagation request itself is invalid (HTTP 422)."""


# ---------------------------------------------------------------- helpers ----
def _pick_channel_trace(traces: Sequence[dict[str, Any]], station: str,
                        channel: str, around_ms: int) -> dict[str, Any]:
    """Pick the trace for station/channel, preferring one covering ``around_ms``."""
    same = [t for t in traces
            if t["station"] == station and t["channel"] == channel]
    if not same:
        raise CorrelationError(
            f"模板台站 {station!r} 没有通道 {channel!r} 的波形")
    covering = [t for t in same
                if t["start_time"] <= around_ms <= t["end_time"]]
    candidates = covering or same
    candidates.sort(key=lambda t: (t["id"],))
    return candidates[0]


def _station_channel_traces(traces: Sequence[dict[str, Any]],
                            ) -> dict[tuple[str, str], list[dict[str, Any]]]:
    out: dict[tuple[str, str], list[dict[str, Any]]] = {}
    for t in traces:
        out.setdefault((t["station"], t["channel"]), []).append(t)
    return out


def _template_samples(trace: dict[str, Any], t0_ms: int,
                      half_window_ms: int) -> tuple[list[float], int]:
    """Cut ``[t0-half, t0+half]`` and express it on the trace's sample grid.

    Returns (samples, k) where ``k`` is the template half-length in samples.
    The window is clipped to whole samples on either side and must fully lie
    inside the trace.
    """
    sr = trace["sample_rate"]
    lo = t0_ms - half_window_ms
    hi = t0_ms + half_window_ms
    if lo < trace["start_time"] or hi > trace["end_time"]:
        raise CorrelationError(
            f"模板窗 [{lo}, {hi}] 超出模板波形范围 "
            f"[{trace['start_time']}, {trace['end_time']}]")
    k = int(half_window_ms * sr // 1000)
    if k < 1:
        raise CorrelationError(
            f"模板窗在 {sr:g} Hz 采样率下不足 1 个采样点，请增大模板窗")
    i0 = int(round((lo - trace["start_time"]) * sr / 1000.0))
    n = 2 * k + 1
    if n > MAX_TEMPLATE_SAMPLES:
        raise CorrelationError(
            f"模板采样点过多（{n} > {MAX_TEMPLATE_SAMPLES}），请减小模板窗")
    samples = [float(x) for x in trace["samples"][i0:i0 + n]]
    if len(samples) < n:  # defensive: end rounding should already guarantee this
        raise CorrelationError("模板窗覆盖不足")
    return samples, k


def _resample_template(template: list[float], src_sr: float,
                       dst_sr: float) -> list[float]:
    """Linearly resample a template onto another sample rate.

    The sample index of the pick maps as ``i * src_sr/dst_sr`` so the
    resampled series stays aligned at the central sample.
    """
    if abs(dst_sr - src_sr) <= 1e-12:
        return list(template)
    ratio = src_sr / dst_sr
    n_dst = max(1, int(round((len(template) - 1) / ratio)) + 1)
    out: list[float] = []
    for j in range(n_dst):
        pos = j * ratio
        i = int(pos)
        if i >= len(template) - 1:
            out.append(template[-1])
            continue
        frac = pos - i
        out.append(template[i] * (1.0 - frac) + template[i + 1] * frac)
    return out


# -------------------------------------------------------------- core scan ----
def _scan_target(
    target: dict[str, Any],
    t0_ms: int,
    template_dst: list[float],
    k_dst: int,
    max_shift_ms: int,
) -> dict[str, Any]:
    """Slide one (already rate-matched) template over one target trace."""
    sr = target["sample_rate"]
    samples = target["samples"]
    dt_ms = 1000.0 / sr

    a = template_dst
    n = len(a)
    a_mean = sum(a) / n
    a0 = [v - a_mean for v in a]
    a_energy = sum(v * v for v in a0)
    if a_energy <= ENERGY_EPS * max(1.0, max(abs(v) for v in a) ** 2):
        return {"available": False, "reason": REASON_TEMPLATE_CONSTANT}

    anchor = int(round((t0_ms - target["start_time"]) * sr / 1000.0))
    lag_max = int(max_shift_ms * sr // 1000)
    if lag_max > MAX_LAG_SAMPLES:
        raise CorrelationError(
            f"时移范围对应 {2 * lag_max + 1} 个滞后点，请减小最大时移")

    # Full-coverage lags only: window [c+lag-k, c+lag+k] inside the trace.
    lo_lag = max(-lag_max, k_dst - anchor)
    hi_lag = min(lag_max, len(samples) - 1 - k_dst - anchor)
    if lo_lag > hi_lag:
        return {"available": False, "reason": REASON_INSUFFICIENT_COVERAGE}

    best: tuple[float, int, int] | None = None  # (-coef, |lag|, lag)
    any_constant = True
    for lag in range(lo_lag, hi_lag + 1):
        c = anchor + lag
        seg = samples[c - k_dst:c - k_dst + n]
        b_mean = sum(seg) / n
        b_energy = 0.0
        dot = 0.0
        b_max = 0.0
        for i in range(n):
            dv = seg[i] - b_mean
            b_energy += dv * dv
            dot += a0[i] * dv
            av = abs(seg[i])
            if av > b_max:
                b_max = av
        if b_energy <= ENERGY_EPS * max(1.0, b_max ** 2):
            continue  # constant sliding window: unnormalisable lag
        any_constant = False
        coef = dot / (a_energy * b_energy) ** 0.5
        if coef > 1.0:
            coef = 1.0
        elif coef < -1.0:
            coef = -1.0
        # higher coef, then smaller |shift|, then earlier arrival (smaller lag)
        key = (-coef, abs(lag), lag)
        if best is None or _peak_better(key, best):
            best = key

    if best is None:
        return {"available": False,
                "reason": (REASON_CONSTANT_WINDOW if any_constant
                           else REASON_INSUFFICIENT_COVERAGE)}

    neg_coef, _, lag = best
    coef = -neg_coef
    shift_ms = lag * dt_ms
    arrival_ms = t0_ms + shift_ms
    return {
        "available": True,
        "coefficient": round(coef, 6),
        "lag_samples": lag,
        "shift_ms": int(round(shift_ms)),
        "time": int(round(arrival_ms)),
        "window_start": int(round(arrival_ms - k_dst * dt_ms)),
        "window_end": int(round(arrival_ms + k_dst * dt_ms)),
    }


def _peak_better(a: tuple[float, int, int],
                 b: tuple[float, int, int]) -> bool:
    """Ordering implementing the documented tie-break rules.

    Coefficients within ``PEAK_EPS`` are considered tied; among ties the
    smaller absolute shift wins, then the earlier time (smaller lag).
    """
    if a[0] < b[0] - PEAK_EPS:
        return True
    if a[0] > b[0] + PEAK_EPS:
        return False
    if a[1] != b[1]:
        return a[1] < b[1]
    return a[2] < b[2]


# ---------------------------------------------------------------- public ----
def preview(
    traces: Sequence[dict[str, Any]],
    template_pick: dict[str, Any],
    channel: str,
    half_window_ms: int,
    max_shift_ms: int,
    min_coefficient: float,
    target_stations: Sequence[str] | None,
) -> dict[str, Any]:
    """Compute the proposed arrival for every requested target station."""
    station = template_pick["station"]
    phase = template_pick["phase"]
    t0 = template_pick["time"]

    src = _pick_channel_trace(traces, station, channel, t0)
    raw_template, k_src = _template_samples(src, t0, half_window_ms)

    index = _station_channel_traces(traces)
    if target_stations is None:
        targets = sorted({t["station"]
                          for t in traces if t["channel"] == channel})
    else:
        targets = list(dict.fromkeys(target_stations))  # de-dup, keep order
        unknown = [s for s in targets if not any(
            t["station"] == s for t in traces)]
        if unknown:
            raise CorrelationError("未知目标台站：" + ", ".join(unknown))

    results: list[dict[str, Any]] = []
    for sta in targets:
        sta_traces = index.get((sta, channel), [])
        covering = [t for t in sta_traces
                    if t["start_time"] <= t0 <= t["end_time"]]
        base: dict[str, Any] = {
            "station": sta,
            "phase": phase,
            "channel": channel,
            "available": False,
            "coefficient": None,
            "shift_ms": None,
            "time": None,
            "window_start": None,
            "window_end": None,
            "reason": None,
        }
        if not sta_traces:
            base["reason"] = REASON_NO_CHANNEL
            results.append(base)
            continue
        # Traces that do not even cover the template pick time can never hold
        # a full template window; report them as insufficient coverage.
        if not covering:
            base["reason"] = REASON_INSUFFICIENT_COVERAGE
            results.append(base)
            continue

        scan: dict[str, Any] | None = None
        for tr in sorted(covering, key=lambda t: t["id"]):
            template_dst = _resample_template(
                raw_template, src["sample_rate"], tr["sample_rate"])
            k_dst = (len(template_dst) - 1) // 2
            out = _scan_target(tr, t0, template_dst, k_dst, max_shift_ms)
            if out.get("available"):
                scan = out
                break
            # remember the most informative failure: prefer coverage over
            # constant-window, and never let a duplicate trace hide a usable
            # one (loop continues over the remaining covering traces).
            if scan is None or (
                scan.get("reason") == REASON_CONSTANT_WINDOW
                and out.get("reason") == REASON_INSUFFICIENT_COVERAGE
            ):
                scan = out
        assert scan is not None
        base.update(scan)
        if base["available"]:
            base["meets_threshold"] = (
                base["coefficient"] is not None
                and base["coefficient"] + PEAK_EPS >= min_coefficient)
        else:
            base["meets_threshold"] = False
            base["reason_text"] = REASON_TEXT.get(base["reason"], base["reason"])
        results.append(base)

    return {
        "template": {
            "pick_id": template_pick["id"],
            "station": station,
            "phase": phase,
            "time": t0,
            "channel": channel,
            "half_window_ms": half_window_ms,
            "sample_rate": src["sample_rate"],
            "template_samples": 2 * k_src + 1,
        },
        "max_shift_ms": max_shift_ms,
        "min_coefficient": min_coefficient,
        "results": results,
    }
