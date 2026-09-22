import type {
  Analysis, CorrelationApplyResponse, CorrelationParams,
  CorrelationPreview, CorrelationResult, Pick, Trace,
} from "./types.js";
import { msToIso } from "./time.js";

export interface CorrelationDialogCallbacks {
  getPicks: () => Pick[];
  getTraces: () => Trace[];
  preview: (params: CorrelationParams) => Promise<CorrelationPreview>;
  apply: (params: CorrelationParams, stations: string[]) =>
    Promise<CorrelationApplyResponse>;
  locate: (station: string, time: number | null) => void;
  onApplied: (analysis: Analysis) => void;
  onPreviewChange: (preview: CorrelationPreview | null) => void;
  toast: (msg: string, isError?: boolean) => void;
}

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K, cls = "",
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  return node;
}

const DEFAULT_HALF_WINDOW = 300;
const DEFAULT_MAX_SHIFT = 2000;
const DEFAULT_MIN_CC = 0.7;

export class CorrelationDialog {
  private cb: CorrelationDialogCallbacks;
  private overlay: HTMLDivElement;
  private pickSelect!: HTMLSelectElement;
  private channelSelect!: HTMLSelectElement;
  private halfInput!: HTMLInputElement;
  private shiftInput!: HTMLInputElement;
  private ccInput!: HTMLInputElement;
  private targetBox!: HTMLDivElement;
  private resultBox!: HTMLDivElement;
  private statusLine!: HTMLDivElement;
  private applyBtn!: HTMLButtonElement;

  private previewData: CorrelationPreview | null = null;
  private checked = new Set<string>();

  constructor(cb: CorrelationDialogCallbacks) {
    this.cb = cb;
    this.overlay = el("div", "modal-overlay");
    this.overlay.hidden = true;
    this.overlay.addEventListener("mousedown", (e) => {
      if (e.target === this.overlay) this.close();
    });
    document.body.appendChild(this.overlay);
    this.buildDom();
  }

  // ------------------------------------------------------------- build ----
  private buildDom() {
    const dlg = el("div", "xc-dialog");
    this.overlay.appendChild(dlg);

    const head = el("div", "xc-head");
    const title = el("span", "xc-title");
    title.textContent = "🔗 相关传播：用模板拾取互相关定位其他台站到时";
    head.appendChild(title);
    const close = el("button", "xc-close");
    close.textContent = "✕";
    close.title = "关闭";
    close.addEventListener("click", () => this.close());
    head.appendChild(close);
    dlg.appendChild(head);

    const form = el("div", "xc-form");
    form.appendChild(this.field("模板拾取", this.pickSelect = el("select")));
    form.appendChild(this.field("通道", this.channelSelect = el("select")));
    this.halfInput = el("input");
    this.halfInput.type = "number";
    this.halfInput.min = "1";
    this.halfInput.step = "10";
    this.halfInput.value = String(DEFAULT_HALF_WINDOW);
    form.appendChild(this.field("模板窗 ±ms", this.halfInput));
    this.shiftInput = el("input");
    this.shiftInput.type = "number";
    this.shiftInput.min = "1";
    this.shiftInput.step = "100";
    this.shiftInput.value = String(DEFAULT_MAX_SHIFT);
    form.appendChild(this.field("最大时移 ±ms", this.shiftInput));
    this.ccInput = el("input");
    this.ccInput.type = "number";
    this.ccInput.min = "0";
    this.ccInput.max = "1";
    this.ccInput.step = "0.05";
    this.ccInput.value = String(DEFAULT_MIN_CC);
    form.appendChild(this.field("最低相关系数", this.ccInput));
    dlg.appendChild(form);

    for (const node of [this.pickSelect, this.channelSelect,
      this.halfInput, this.shiftInput, this.ccInput]) {
      node.addEventListener("change", () => this.invalidate());
    }
    this.pickSelect.addEventListener("change", () => {
      this.rebuildChannels();
      this.rebuildTargets();
    });
    this.channelSelect.addEventListener("change", () => this.rebuildTargets());

    const tgtHead = el("div", "xc-section-head");
    const tgtTitle = el("span");
    tgtTitle.textContent = "目标台站（预览后仅可勾选达到阈值的结果）";
    tgtHead.appendChild(tgtTitle);
    const allBtn = el("button", "mini link");
    allBtn.textContent = "全选可达";
    allBtn.type = "button";
    allBtn.addEventListener("click", () => {
      if (!this.previewData) return;
      this.checked = new Set(this.previewData.results
        .filter(r => r.available && r.meets_threshold)
        .map(r => r.station));
      this.syncCheckboxes();
    });
    tgtHead.appendChild(allBtn);
    const noneBtn = el("button", "mini link");
    noneBtn.textContent = "清空";
    noneBtn.type = "button";
    noneBtn.addEventListener("click", () => {
      this.checked.clear();
      this.syncCheckboxes();
    });
    tgtHead.appendChild(noneBtn);
    dlg.appendChild(tgtHead);

    this.targetBox = el("div", "xc-targets");
    dlg.appendChild(this.targetBox);

    const previewBtn = el("button", "btn btn-small btn-primary");
    previewBtn.textContent = "计算预览";
    previewBtn.type = "button";
    previewBtn.addEventListener("click", () => void this.runPreview());

    this.resultBox = el("div", "xc-results");
    const resWrap = el("div", "xc-results-wrap");
    resWrap.appendChild(this.resultBox);
    dlg.appendChild(resWrap);

    const footer = el("div", "xc-footer");
    this.statusLine = el("div", "xc-status");
    footer.appendChild(this.statusLine);
    footer.appendChild(previewBtn);
    this.applyBtn = el("button", "btn btn-small btn-primary");
    this.applyBtn.textContent = "确认创建拾取";
    this.applyBtn.type = "button";
    this.applyBtn.disabled = true;
    this.applyBtn.addEventListener("click", () => void this.doApply());
    footer.appendChild(this.applyBtn);
    const cancel = el("button", "btn btn-small");
    cancel.textContent = "取消";
    cancel.type = "button";
    cancel.addEventListener("click", () => this.close());
    footer.appendChild(cancel);
    dlg.appendChild(footer);
  }

  private field(label: string, input: HTMLElement): HTMLElement {
    const wrap = el("label", "xc-field");
    const lab = el("span");
    lab.textContent = label;
    wrap.appendChild(lab);
    wrap.appendChild(input);
    return wrap;
  }

  // ------------------------------------------------------------ open/close
  open(preselectedPickId: number | null = null) {
    const picks = this.cb.getPicks();
    this.pickSelect.innerHTML = "";
    if (!picks.length) {
      const o = el("option");
      o.value = "";
      o.textContent = "（暂无拾取）";
      this.pickSelect.appendChild(o);
    } else {
      const byStation = new Map<string, Pick[]>();
      for (const p of picks) {
        const arr = byStation.get(p.station) ?? [];
        arr.push(p);
        byStation.set(p.station, arr);
      }
      for (const sta of [...byStation.keys()].sort()) {
        const og = el("optgroup");
        og.label = sta;
        for (const p of byStation.get(sta)!
          .sort((a, b) => a.phase.localeCompare(b.phase) || a.time - b.time)) {
          const o = el("option");
          o.value = String(p.id);
          o.textContent = `${p.phase} @ ${msToIso(p.time).slice(11, 23)}`
            + ` · ${p.source}${p.status === "rejected" ? " · 已拒绝" : ""}`;
          og.appendChild(o);
        }
        this.pickSelect.appendChild(og);
      }
    }
    if (preselectedPickId != null
        && picks.some(p => p.id === preselectedPickId)) {
      this.pickSelect.value = String(preselectedPickId);
    }
    this.invalidate();
    this.rebuildChannels();
    this.rebuildTargets();
    this.overlay.hidden = false;
  }

  close() {
    this.overlay.hidden = true;
    this.invalidate();
  }

  // ------------------------------------------------------------- helpers ---
  private currentPick(): Pick | null {
    const id = Number(this.pickSelect.value);
    return this.cb.getPicks().find(p => p.id === id) ?? null;
  }

  private stationChannels(station: string): string[] {
    const set = new Set<string>();
    for (const t of this.cb.getTraces()) {
      if (t.station === station) set.add(t.channel);
    }
    return [...set].sort();
  }

  private rebuildChannels() {
    const p = this.currentPick();
    const prev = this.channelSelect.value;
    this.channelSelect.innerHTML = "";
    if (!p) return;
    const channels = this.stationChannels(p.station);
    // prefer a vertical channel, otherwise first alphabetical
    const preferred = channels.find(c => c.endsWith("Z")) ?? channels[0];
    for (const c of channels) {
      const o = el("option");
      o.value = c;
      o.textContent = c;
      this.channelSelect.appendChild(o);
    }
    this.channelSelect.value = channels.includes(prev) ? prev : preferred;
  }

  private rebuildTargets() {
    const p = this.currentPick();
    const channel = this.channelSelect.value;
    this.targetBox.innerHTML = "";
    if (!p || !channel) return;
    const stations = [...new Set(this.cb.getTraces()
      .filter(t => t.channel === channel).map(t => t.station))].sort();
    // default: every station except the template station itself
    this.checked = new Set(stations.filter(s => s !== p.station));
    for (const sta of stations) {
      const lab = el("label", "xc-target");
      const cb0 = el("input");
      cb0.type = "checkbox";
      cb0.value = sta;
      cb0.checked = this.checked.has(sta);
      cb0.addEventListener("change", () => {
        if (cb0.checked) this.checked.add(sta);
        else this.checked.delete(sta);
        this.syncCheckboxes();
      });
      lab.appendChild(cb0);
      const txt = el("span");
      txt.textContent = sta + (sta === p.station ? "（模板台站）" : "");
      lab.appendChild(txt);
      this.targetBox.appendChild(lab);
    }
  }

  private invalidate() {
    this.previewData = null;
    this.cb.onPreviewChange(null);
    this.resultBox.innerHTML = "";
    this.applyBtn.disabled = true;
    this.setStatus("");
  }

  private setStatus(msg: string, isError = false) {
    this.statusLine.textContent = msg;
    this.statusLine.classList.toggle("error", isError);
  }

  private params(): CorrelationParams | null {
    const p = this.currentPick();
    if (!p) return null;
    const half = Number(this.halfInput.value);
    const shift = Number(this.shiftInput.value);
    const cc = Number(this.ccInput.value);
    if (!(half >= 1) || !(shift >= 1) || !(cc >= 0 && cc <= 1)) {
      this.setStatus("请检查模板窗 / 最大时移 / 最低相关系数的取值", true);
      return null;
    }
    return {
      template_pick_id: p.id,
      channel: this.channelSelect.value,
      half_window_ms: Math.round(half),
      max_shift_ms: Math.round(shift),
      min_coefficient: cc,
    };
  }

  // -------------------------------------------------------------- preview --
  private async runPreview() {
    const params = this.params();
    if (!params) return;
    this.setStatus("计算中…");
    try {
      const data = await this.cb.preview(params);
      this.previewData = data;
      this.checked = new Set(data.results
        .filter(r => r.available && r.meets_threshold)
        .map(r => r.station));
      this.cb.onPreviewChange(data);
      this.renderResults();
      const nOk = data.results.filter(r =>
        r.available && r.meets_threshold).length;
      const nUn = data.results.filter(r => !r.available).length;
      this.setStatus(`预览完成：${nOk} 个台站达到阈值`
        + (nUn ? `，${nUn} 个不可用` : ""));
    } catch (err) {
      this.setStatus((err as Error).message, true);
    }
  }

  private syncCheckboxes() {
    if (!this.previewData) {
      this.targetBox.querySelectorAll<HTMLInputElement>(
        "input[type=checkbox]").forEach(cb0 => {
        cb0.checked = this.checked.has(cb0.value);
      });
      return;
    }
    const okStations = new Set(this.previewData.results
      .filter(r => r.available && r.meets_threshold).map(r => r.station));
    this.targetBox.querySelectorAll<HTMLInputElement>(
      "input[type=checkbox]").forEach(cb0 => {
      const allowed = okStations.has(cb0.value);
      cb0.disabled = !allowed;
      cb0.checked = allowed && this.checked.has(cb0.value);
    });
    this.applyBtn.disabled =
      ![...this.checked].some(s => okStations.has(s));
  }

  private renderResults() {
    const data = this.previewData;
    this.resultBox.innerHTML = "";
    if (!data) return;
    const tpl = data.template;

    const info = el("div", "xc-info");
    info.textContent = `模板：${tpl.station} ${tpl.phase} @ `
      + `${msToIso(tpl.time).slice(11, 23)} · ${tpl.channel} · `
      + `${tpl.template_samples} 采样点（±${tpl.half_window_ms}ms）`;
    this.resultBox.appendChild(info);

    const table = el("table", "xc-table");
    const thead = el("thead");
    const hr = el("tr");
    for (const h of ["", "台站", "建议到时 (UTC)", "时移", "相关系数", "状态", ""]) {
      const th = el("th");
      th.textContent = h;
      hr.appendChild(th);
    }
    thead.appendChild(hr);
    table.appendChild(thead);

    const tbody = el("tbody");
    for (const r of data.results) {
      tbody.appendChild(this.renderResultRow(r, tpl.station));
    }
    table.appendChild(tbody);
    this.resultBox.appendChild(table);
    this.syncCheckboxes();
  }

  private renderResultRow(r: CorrelationResult,
                          templateStation: string): HTMLTableRowElement {
    const tr = el("tr");
    if (!r.available) tr.className = "unavailable";
    else if (!r.meets_threshold) tr.className = "below";

    const tdCheck = el("td");
    const cb0 = el("input");
    cb0.type = "checkbox";
    cb0.value = r.station;
    const allowed = r.available && r.meets_threshold === true;
    cb0.disabled = !allowed;
    cb0.checked = allowed && this.checked.has(r.station);
    cb0.addEventListener("change", () => {
      if (cb0.checked) this.checked.add(r.station);
      else this.checked.delete(r.station);
      this.syncCheckboxes();
    });
    tdCheck.appendChild(cb0);
    tr.appendChild(tdCheck);

    const tdSta = el("td");
    tdSta.textContent = r.station
      + (r.station === templateStation ? "（模板）" : "");
    tr.appendChild(tdSta);

    const tdTime = el("td", "num");
    tdTime.textContent = r.time != null
      ? msToIso(r.time).slice(11, 23) : "—";
    tr.appendChild(tdTime);

    const tdShift = el("td", "num");
    if (r.shift_ms != null) {
      tdShift.textContent = `${r.shift_ms >= 0 ? "+" : ""}${r.shift_ms} ms`;
    } else tdShift.textContent = "—";
    tr.appendChild(tdShift);

    const tdCc = el("td", "num cc");
    if (r.coefficient != null) {
      tdCc.textContent = r.coefficient.toFixed(3);
      if (r.meets_threshold) tdCc.classList.add("good");
    } else tdCc.textContent = "—";
    tr.appendChild(tdCc);

    const tdStatus = el("td", "xc-result-status");
    if (!r.available) {
      tdStatus.textContent = r.reason_text ?? r.reason ?? "不可用";
      tdStatus.title = r.reason ?? "";
    } else if (!r.meets_threshold) {
      tdStatus.textContent = "低于阈值";
      tdStatus.classList.add("dim");
    } else {
      tdStatus.textContent = "✓ 达到阈值";
      tdStatus.classList.add("good");
    }
    tr.appendChild(tdStatus);

    const tdLocate = el("td");
    const locBtn = el("button", "mini link");
    locBtn.textContent = "定位";
    locBtn.type = "button";
    locBtn.disabled = !r.available;
    locBtn.addEventListener("click", () =>
      this.cb.locate(r.station, r.time));
    tdLocate.appendChild(locBtn);
    tr.appendChild(tdLocate);
    return tr;
  }

  // ---------------------------------------------------------------- apply --
  private async doApply() {
    const params = this.params();
    if (!params || !this.previewData) return;
    const okStations = new Set(this.previewData.results
      .filter(r => r.available && r.meets_threshold)
      .map(r => r.station));
    const stations = [...this.checked].filter(s => okStations.has(s));
    if (!stations.length) {
      this.setStatus("未勾选任何达到阈值的台站", true);
      return;
    }
    if (!confirm(`确认为 ${stations.length} 个台站创建相关传播拾取？\n`
      + "已有同台站 / 同震相 / 同时刻到时的项将自动跳过。")) return;
    this.applyBtn.disabled = true;
    this.setStatus("创建中…");
    try {
      const res = await this.cb.apply(params, stations);
      const o = res.propagation;
      this.cb.onApplied(res.analysis);
      const notes = [`新建 ${o.created.length} 条`];
      if (o.skipped.length) notes.push(`跳过重复 ${o.skipped.length} 条`);
      if (o.below_threshold.length)
        notes.push(`低于阈值 ${o.below_threshold.length} 条`);
      if (o.unavailable.length)
        notes.push(`不可用 ${o.unavailable.length} 条`);
      this.cb.toast(`相关传播完成：${notes.join("，")}`);
      this.overlay.hidden = true;
      this.previewData = null;
      this.cb.onPreviewChange(null);
    } catch (err) {
      this.setStatus((err as Error).message, true);
      this.applyBtn.disabled = false;
    }
  }
}
