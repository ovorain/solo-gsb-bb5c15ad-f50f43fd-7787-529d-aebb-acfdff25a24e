import { api } from "./api.js";
import type {
  CorrelationParams, CorrelationPreview, CorrelationResult, Pick, Trace,
} from "./types.js";
import { msToIso } from "./time.js";

export interface CorrelationModalCallbacks {
  onApplied: (created: number, skipped: number) => void;
  onPreviewOverlay: (preview: CorrelationPreview | null) => void;
  onLocate: (result: CorrelationResult, halfWindowMs: number) => void;
}

interface Options {
  channels: string[];
  stations: string[];
}

function h(tag: string, cls = ""): HTMLElement {
  const el = document.createElement(tag);
  if (cls) el.className = cls;
  return el;
}

const DEFAULTS = {
  channel: "HHZ", windowMs: 400, maxShiftMs: 5000, minCc: 0.6,
};

export class CorrelationModal {
  private el: HTMLDivElement;
  private cb: CorrelationModalCallbacks;
  private dsId: number | null = null;
  private picks: Pick[] = [];
  private traces: Trace[] = [];
  private preview: CorrelationPreview | null = null;
  private busy = false;

  constructor(cb: CorrelationModalCallbacks) {
    this.cb = cb;
    this.el = document.createElement("div");
    this.el.className = "modal-backdrop";
    this.el.hidden = true;
    this.el.innerHTML = `
      <div class="modal corr-modal">
        <div class="modal-head">
          <span>🔗 相关传播</span>
          <button class="modal-close" title="关闭">×</button>
        </div>
        <div class="modal-body">
          <div class="corr-form">
            <label>模板拾取
              <select class="f-pick"></select>
            </label>
            <label>通道
              <select class="f-channel"></select>
            </label>
            <label>模板半窗 ±<input class="f-window" type="number"
                   min="10" max="60000" step="10" value="${DEFAULTS.windowMs}" /> ms</label>
            <label>最大时移 ±<input class="f-shift" type="number"
                   min="0" max="120000" step="100" value="${DEFAULTS.maxShiftMs}" /> ms</label>
            <label>最低相关系数 <input class="f-cc" type="number"
                   min="-1" max="1" step="0.05" value="${DEFAULTS.minCc}" /></label>
          </div>
          <div class="corr-stations">
            <div class="corr-stations-head">
              <span>目标台站</span>
              <span class="corr-station-tools">
                <button class="mini link b-all">全选</button>
                <button class="mini link b-none">清空</button>
              </span>
            </div>
            <div class="corr-station-list"></div>
          </div>
          <div class="corr-preview"></div>
        </div>
        <div class="modal-foot">
          <span class="corr-status"></span>
          <span class="spacer"></span>
          <button class="btn btn-small b-cancel">取消</button>
          <button class="btn btn-small btn-primary b-preview">计算预览</button>
          <button class="btn btn-small btn-primary b-apply" disabled>确认创建拾取</button>
        </div>
      </div>`;
    document.body.appendChild(this.el);

    this.el.querySelector(".modal-close")!.addEventListener("click",
      () => this.close());
    this.el.querySelector(".b-cancel")!.addEventListener("click",
      () => this.close());
    this.el.addEventListener("pointerdown", (e) => {
      if (e.target === this.el) this.close();
    });
    this.el.querySelector(".b-preview")!.addEventListener("click",
      () => void this.runPreview());
    this.el.querySelector(".b-apply")!.addEventListener("click",
      () => void this.apply());
    this.el.querySelector(".b-all")!.addEventListener("click",
      () => this.toggleAll(true));
    this.el.querySelector(".b-none")!.addEventListener("click",
      () => this.toggleAll(false));
    this.el.querySelector<HTMLSelectElement>(".f-pick")!
      .addEventListener("change", () => this.clearPreview());
    this.el.querySelector<HTMLSelectElement>(".f-channel")!
      .addEventListener("change", () => this.clearPreview());
    // changing the pick refreshes the target-station list (exclude template)
    this.el.querySelector<HTMLSelectElement>(".f-pick")!
      .addEventListener("change", () => this.renderStations());
  }

  // ------------------------------------------------------------- open ------
  open(dsId: number, picks: Pick[], traces: Trace[], preselectPickId?: number) {
    this.dsId = dsId;
    this.picks = picks;
    this.traces = traces;
    this.clearPreview();

    const pickSel = this.el.querySelector<HTMLSelectElement>(".f-pick")!;
    pickSel.innerHTML = "";
    const sorted = [...picks].sort((a, b) =>
      a.station.localeCompare(b.station)
      || (a.phase === "P" ? -1 : 1) || a.time - b.time);
    for (const p of sorted) {
      const o = document.createElement("option");
      o.value = String(p.id);
      o.textContent = `${p.station} ${p.phase} ${msToIso(p.time).slice(11, 23)}`
        + ` (${p.source})${p.status === "rejected" ? " · 已拒绝" : ""}`;
      pickSel.appendChild(o);
    }
    if (preselectPickId != null
        && sorted.some(p => p.id === preselectPickId)) {
      pickSel.value = String(preselectPickId);
    }

    const opts = this.optionInfo();
    const chSel = this.el.querySelector<HTMLSelectElement>(".f-channel")!;
    chSel.innerHTML = "";
    for (const c of opts.channels) {
      const o = document.createElement("option");
      o.value = c;
      o.textContent = c;
      if (c === DEFAULTS.channel) o.selected = true;
      chSel.appendChild(o);
    }
    if (!opts.channels.includes(DEFAULTS.channel)) {
      chSel.value = opts.channels[0] ?? "";
    }
    this.renderStations();
    this.setStatus("");
    this.el.hidden = false;
  }

  close() {
    this.el.hidden = true;
    this.clearPreview();
  }

  // ------------------------------------------------------------ helpers ----
  private optionInfo(): Options {
    const channels = [...new Set(this.traces.map(t => t.channel))].sort();
    const stations = [...new Set(this.traces.map(t => t.station))].sort();
    return { channels, stations };
  }

  private currentPick(): Pick | null {
    const id = Number(this.el
      .querySelector<HTMLSelectElement>(".f-pick")!.value);
    return this.picks.find(p => p.id === id) ?? null;
  }

  private formParams(): CorrelationParams | string {
    const pick = this.currentPick();
    if (!pick) return "请选择模板拾取";
    const channel = this.el
      .querySelector<HTMLSelectElement>(".f-channel")!.value.trim();
    if (!channel) return "请选择通道";
    const windowMs = Number(
      this.el.querySelector<HTMLInputElement>(".f-window")!.value);
    const maxShiftMs = Number(
      this.el.querySelector<HTMLInputElement>(".f-shift")!.value);
    const minCc = Number(
      this.el.querySelector<HTMLInputElement>(".f-cc")!.value);
    if (!(windowMs > 0) || windowMs > 60000) return "模板半窗须在 1–60000 ms 之间";
    if (!(maxShiftMs >= 0) || maxShiftMs > 120000) return "最大时移须在 0–120000 ms 之间";
    if (!(minCc >= -1 && minCc <= 1)) return "最低相关系数须在 -1～1 之间";
    const stations = [...this.el
      .querySelectorAll<HTMLInputElement>(".station-check:checked")]
      .map(cb => cb.value);
    if (!stations.length) return "请至少选择一个目标台站";
    return {
      pick_id: pick.id, channel, window_ms: Math.round(windowMs),
      max_shift_ms: Math.round(maxShiftMs), min_cc: minCc, stations,
    };
  }

  private renderStations() {
    const pick = this.currentPick();
    const list = this.el.querySelector(".corr-station-list")!;
    list.innerHTML = "";
    const { stations } = this.optionInfo();
    for (const st of stations) {
      if (pick && st === pick.station) continue;
      const lab = document.createElement("label");
      lab.className = "corr-station";
      const cb = document.createElement("input");
      cb.type = "checkbox";
      cb.className = "station-check";
      cb.value = st;
      cb.checked = true;
      lab.appendChild(cb);
      lab.appendChild(document.createTextNode(st));
      list.appendChild(lab);
    }
    if (!list.children.length) {
      const ph = h("p", "placeholder");
      ph.textContent = "没有可选目标台站";
      list.appendChild(ph);
    }
  }

  private toggleAll(on: boolean) {
    this.el.querySelectorAll<HTMLInputElement>(".station-check")
      .forEach(cb => { cb.checked = on; });
  }

  private clearPreview() {
    this.preview = null;
    this.el.querySelector(".corr-preview")!.innerHTML = "";
    this.el.querySelector<HTMLButtonElement>(".b-apply")!.disabled = true;
    this.cb.onPreviewOverlay(null);
  }

  private setStatus(msg: string, isError = false) {
    const el = this.el.querySelector(".corr-status")!;
    el.textContent = msg;
    el.classList.toggle("error", isError);
  }

  // ------------------------------------------------------------ preview ----
  private async runPreview() {
    if (this.busy) return;
    const params = this.formParams();
    if (typeof params === "string") {
      this.setStatus(params, true);
      return;
    }
    this.busy = true;
    this.setStatus("计算中…");
    try {
      this.preview = await api.correlationPreview(this.dsId!, params);
      this.renderPreview(params);
      const ok = this.preview.results.filter(r => r.meets_threshold).length;
      const bad = this.preview.results.length - ok;
      this.setStatus(`预览完成：${ok} 个台站达到阈值`
        + (bad ? `，${bad} 个不可用/未达标` : ""));
    } catch (err) {
      this.clearPreview();
      this.setStatus(`预览失败：${(err as Error).message}`, true);
    } finally {
      this.busy = false;
    }
  }

  private renderPreview(params: CorrelationParams) {
    const box = this.el.querySelector(".corr-preview")!;
    box.innerHTML = "";
    if (!this.preview) return;

    const tpl = this.preview.template;
    const head = h("div", "corr-preview-head");
    head.innerHTML = `模板 <b>${tpl.station}</b> ${tpl.phase} @ `
      + `${msToIso(tpl.time).slice(11, 23)} · ${tpl.channel}`;
    box.appendChild(head);

    // Map requested order back; the backend preserves station order.
    const byStation = new Map(this.preview.results.map(r => [r.station, r]));
    for (const station of params.stations) {
      const r = byStation.get(station);
      if (r) box.appendChild(this.renderResultRow(r, params.window_ms));
    }
    this.cb.onPreviewOverlay(this.preview);
  }

  private renderResultRow(r: CorrelationResult, halfWindowMs: number): HTMLElement {
    const row = h("label", "corr-result"
      + (r.usable ? (r.meets_threshold ? " ok" : " low") : " unusable"));
    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.className = "result-check";
    cb.value = r.station;
    cb.checked = r.meets_threshold;
    cb.disabled = !r.meets_threshold;
    row.appendChild(cb);

    const name = h("span", "cr-station");
    name.textContent = r.station;
    row.appendChild(name);

    const info = h("span", "cr-info");
    if (r.usable && r.suggested_time != null) {
      const sign = r.shift_ms != null && r.shift_ms >= 0 ? "+" : "";
      info.textContent = `${msToIso(r.suggested_time).slice(11, 23)}`
        + ` · Δ ${sign}${r.shift_ms} ms · cc ${r.cc?.toFixed(3)}`;
    } else {
      info.textContent = r.reason ?? "不可用";
      info.classList.add("cr-reason");
    }
    row.appendChild(info);

    if (r.usable && r.suggested_time != null) {
      const loc = h("button", "mini link cr-locate");
      loc.textContent = "定位";
      loc.title = "在波形中定位建议到时";
      loc.addEventListener("click", (e) => {
        e.preventDefault();
        this.cb.onLocate(r, halfWindowMs);
      });
      row.appendChild(loc);
    }
    return row;
  }

  // -------------------------------------------------------------- apply ----
  private async apply() {
    if (this.busy || !this.preview) return;
    const base = this.formParams();
    if (typeof base === "string") {
      this.setStatus(base, true);
      return;
    }
    const chosen = [...this.el
      .querySelectorAll<HTMLInputElement>(".result-check:checked")]
      .map(cb => cb.value);
    if (!chosen.length) {
      this.setStatus("未勾选任何达到阈值的台站", true);
      return;
    }
    const params: CorrelationParams = { ...base, stations: chosen };
    if (!confirm(`确认在所选 ${chosen.length} 个台站创建${this.currentPick()?.phase}`
      + " 相拾取？（同震相同到时的已有拾取将跳过）")) return;

    this.busy = true;
    this.setStatus("创建中…");
    try {
      const res = await api.correlationApply(this.dsId!, params);
      const dup = res.skipped.filter(s => s.reason.includes("已存在")).length;
      this.cb.onApplied(res.created.length, res.skipped.length);
      let msg = `已创建 ${res.created.length} 条拾取`;
      if (res.skipped.length) {
        msg += `；跳过 ${res.skipped.length} 个台站`
          + (dup ? `（其中 ${dup} 个为同到时重复）` : "");
      }
      this.setStatus(msg);
      this.close();
    } catch (err) {
      this.setStatus(`创建失败：${(err as Error).message}`, true);
    } finally {
      this.busy = false;
    }
  }
}
