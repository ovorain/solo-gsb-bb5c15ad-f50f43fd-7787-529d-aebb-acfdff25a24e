"""Template cross-correlation propagation of phase picks.

Given a *template pick* (station, phase, time ``t0``) and a channel:

1. the template waveform window ``[t0-half, t0+half]`` is taken from the
   template station's trace on that channel;
2. it is **linearly resampled** to every target station's sampling rate;
3. it is slid across each target trace in whole target samples within
   ``±max_shift_ms``; at every fully covered shift the **demeaned,
   normalised** cross-correlation coefficient is computed;
4. the largest coefficient wins; tied peaks break toward the smaller
   absolute shift and then the earlier time.

Constant windows (zero variance) or shifts that are not fully covered by
the target trace never produce a coefficient; a station with no valid
shift is reported as unusable with a reason rather than a bogus value.
"""
from __future__ import annotations

import math
from dataclasses import dataclass
from typing import Any, Sequence

_EPS = 1e-9  # ms, for float-safe coverage comparisons


class TemplateError(Exception):
    """The template window itself cannot be used (no coverage / constant)."""


@dataclass
class TraceView:
    station: str
    channel: str
    start_ms: float
    dt_ms: float
    samples: list[float]

    @classmethod
    def from_row(cls, row: dict[str, Any]) -> "TraceView":
        return cls(
            station=row["station"], channel=row["channel"],
            start_ms=float(row["start_time"]),
            dt_ms=1000.0 / float(row["sample_rate"]),
            samples=[float(v) for v in row["samples"]],
        )

    @property
    def end_ms(self) -> float:
        return self.start_ms + (len(self.samples) - 1) * self.dt_ms

    def covers(self, t0_ms: float, half_ms: float) -> bool:
        return t0_ms - half_ms >= self.start_ms - _EPS and \
            t0_ms + half_ms <= self.end_ms + _EPS


def _demeaned(values: Sequence[float]) -> tuple[list[float], float]:
    """Return mean-removed values and their L2 norm."""
    mean = sum(values) / len(values)
    dv = [v - mean for v in values]
    return dv, math.sqrt(sum(v * v for v in dv))


def _resample_linear(
    src_start_ms: float, src_dt_ms: float, src_values: Sequence[float],
    dst_times_ms: Sequence[float],
) -> list[float]:
    """Linearly interpolate a uniformly sampled series at arbitrary times."""
    n = len(src_values)
    last = n - 1
    out: list[float] = []
    for t in dst_times_ms:
        x = (t - src_start_ms) / src_dt_ms
        if x <= 0.0:
            out.append(src_values[0])
            continue
        if x >= last:
            out.append(src_values[last])
            continue
        i = int(math.floor(x))
        f = x - i
        out.append(src_values[i] * (1.0 - f) + src_values[i + 1] * f)
    return out


def prepare_template(
    trace: TraceView, t0_ms: int, half_ms: int,
) -> None:
    """Validate the shared template window; raise ``TemplateError`` if unusable."""
    if not trace.covers(float(t0_ms), float(half_ms)):
        raise TemplateError(
            f"模板窗（{half_ms} ms）超出 {trace.station}/{trace.channel} "
            "波形覆盖范围")
    n_window = int(math.floor(2.0 * half_ms / trace.dt_ms + _EPS)) + 1
    if n_window < 2:
        raise TemplateError("模板窗短于模板道采样间隔，至少需两个采样点")
    i0 = max(0, int(math.ceil((t0_ms - half_ms - trace.start_ms)
                              / trace.dt_ms - _EPS)))
    i1 = min(len(trace.samples) - 1,
             int(math.floor((t0_ms + half_ms - trace.start_ms)
                            / trace.dt_ms + _EPS)))
    _, norm = _demeaned(trace.samples[i0:i1 + 1])
    if norm == 0.0:
        raise TemplateError("模板窗为常量，无法计算归一化互相关")


def correlate(
    template: TraceView,
    target: TraceView,
    t0_ms: int,
    half_ms: int,
    max_shift_ms: int,
) -> dict[str, Any]:
    """Run the resampled-template scan on one target trace.

    Returns ``{"usable": bool, "reason": str | None, "suggested_time": int |
    None, "shift_ms": float | None, "cc": float | None}``.
    """
    dt = target.dt_ms
    m = int(math.floor(2.0 * half_ms / dt + _EPS)) + 1
    if m < 2:
        return {"usable": False,
                "reason": f"模板窗短于目标道 {target.station} 采样间隔",
                "suggested_time": None, "shift_ms": None, "cc": None}

    # Effective half-width at the target sampling grid (<= requested half).
    eff_half = (m - 1) / 2.0 * dt
    dst_times = [t0_ms - eff_half + j * dt for j in range(m)]
    tmpl = _resample_linear(
        template.start_ms, template.dt_ms, template.samples, dst_times)
    td, tnorm = _demeaned(tmpl)
    if tnorm == 0.0:
        return {"usable": False,
                "reason": f"{target.station}：模板窗重采样后为常量",
                "suggested_time": None, "shift_ms": None, "cc": None}

    n = len(target.samples)
    # Whole-sample index of the nominal (zero-shift) window start.
    i0 = int(round((t0_ms - eff_half - target.start_ms) / dt))
    k_max = int(math.floor(max_shift_ms / dt + _EPS))

    # Peak key: higher cc, then smaller |shift|, then earlier time.
    best_key: tuple[float, float, float] | None = None
    best_shift = 0.0
    covered = 0
    constant_windows = 0
    for k in range(-k_max, k_max + 1):
        i = i0 + k
        if i < 0 or i + m > n:
            continue  # window not fully covered at this shift
        covered += 1
        win = target.samples[i:i + m]
        wd, wnorm = _demeaned(win)
        if wnorm == 0.0:
            constant_windows += 1
            continue
        cc = sum(a * b for a, b in zip(td, wd)) / (tnorm * wnorm)
        if cc > 1.0:
            cc = 1.0
        elif cc < -1.0:
            cc = -1.0
        shift = target.start_ms + i * dt + eff_half - t0_ms
        key = (cc, -abs(shift), -shift)
        if best_key is None or key > best_key:
            best_key = key
            best_shift = shift

    if best_key is None:
        if covered == 0:
            reason = "时移范围内波形覆盖不足（无完整模板窗）"
        else:
            reason = (f"时移范围内 {covered} 个目标窗均为常量"
                      if constant_windows == covered
                      else "时移范围内无有效目标窗")
        return {"usable": False, "reason": reason,
                "suggested_time": None, "shift_ms": None, "cc": None}

    cc = best_key[0]
    return {
        "usable": True,
        "reason": None,
        "suggested_time": int(round(t0_ms + best_shift)),
        "shift_ms": round(best_shift, 3),
        "cc": round(cc, 6),
    }
