/** DOM factory helpers for building UI controls programmatically. */

export interface SliderOpts {
  label: string;
  min: number;
  max: number;
  value: number;
  step: number;
  short?: boolean;
  formatVal?: (v: number) => string;
}

export interface SliderResult {
  row: HTMLDivElement;
  slider: HTMLInputElement;
  valSpan: HTMLSpanElement;
  setVal: (v: number) => void;
}

export function createSlider(opts: SliderOpts): SliderResult {
  const row = document.createElement('div');
  row.className = 'ctrl';

  const lbl = document.createElement('label');
  lbl.textContent = opts.label;
  row.appendChild(lbl);

  const slider = document.createElement('input');
  slider.type = 'range';
  slider.min = String(opts.min);
  slider.max = String(opts.max);
  slider.value = String(opts.value);
  slider.step = String(opts.step);
  if (opts.short) slider.classList.add('short');
  row.appendChild(slider);

  const valSpan = document.createElement('span');
  valSpan.className = 'val';
  const fmt = opts.formatVal ?? ((v: number) => String(v));
  valSpan.textContent = fmt(opts.value);
  row.appendChild(valSpan);

  slider.addEventListener('input', () => {
    valSpan.textContent = fmt(parseFloat(slider.value));
  });

  const setVal = (v: number) => {
    slider.value = String(v);
    valSpan.textContent = fmt(v);
  };

  return { row, slider, valSpan, setVal };
}

export interface SelectOpts {
  label: string;
  options: { value: string; text: string; selected?: boolean }[];
}

export interface SelectResult {
  row: HTMLDivElement;
  select: HTMLSelectElement;
}

export function createSelect(opts: SelectOpts): SelectResult {
  const row = document.createElement('div');
  row.className = 'ctrl';

  const lbl = document.createElement('label');
  lbl.textContent = opts.label;
  row.appendChild(lbl);

  const select = document.createElement('select');
  for (const o of opts.options) {
    const opt = document.createElement('option');
    opt.value = o.value;
    opt.textContent = o.text;
    if (o.selected) opt.selected = true;
    select.appendChild(opt);
  }
  row.appendChild(select);

  return { row, select };
}

export interface CheckboxResult {
  row: HTMLDivElement;
  checkbox: HTMLInputElement;
}

export function createCheckbox(label: string, checked = false): CheckboxResult {
  const row = document.createElement('div');
  row.className = 'ctrl';

  const lbl = document.createElement('label');
  lbl.textContent = label;
  row.appendChild(lbl);

  const checkbox = document.createElement('input');
  checkbox.type = 'checkbox';
  checkbox.checked = checked;
  row.appendChild(checkbox);

  return { row, checkbox };
}

export function createButton(text: string, className = ''): HTMLButtonElement {
  const btn = document.createElement('button');
  btn.textContent = text;
  if (className) btn.className = className;
  return btn;
}

export function createColorInput(label: string, value = '#fffaf0'): { row: HTMLDivElement; input: HTMLInputElement } {
  const row = document.createElement('div');
  row.className = 'ctrl';

  const lbl = document.createElement('label');
  lbl.textContent = label;
  row.appendChild(lbl);

  const input = document.createElement('input');
  input.type = 'color';
  input.value = value;
  input.style.cssText = 'width:28px;height:22px;padding:0;border:1px solid #4a4a6a;';
  row.appendChild(input);

  return { row, input };
}

export function createSection(title: string, collapsed = false): { section: HTMLDivElement; header: HTMLDivElement; body: HTMLDivElement } {
  const section = document.createElement('div');
  section.className = 'sidebar-section';

  const header = document.createElement('div');
  header.className = 'section-header';
  const chevron = document.createElement('span');
  chevron.className = 'chevron';
  chevron.textContent = collapsed ? '\u25B6' : '\u25BC';
  header.appendChild(chevron);
  const titleSpan = document.createElement('span');
  titleSpan.textContent = title;
  header.appendChild(titleSpan);
  section.appendChild(header);

  const body = document.createElement('div');
  body.className = 'section-body' + (collapsed ? ' collapsed' : '');
  section.appendChild(body);

  header.addEventListener('click', () => {
    const isCollapsed = body.classList.toggle('collapsed');
    chevron.textContent = isCollapsed ? '\u25B6' : '\u25BC';
  });

  return { section, header, body };
}

export function createTextInput(placeholder: string, width = '72px'): HTMLInputElement {
  const input = document.createElement('input');
  input.type = 'text';
  input.placeholder = placeholder;
  input.style.cssText = `width:${width};background:#2a3a5e;color:#c0c0e0;border:1px solid #4a4a6a;padding:3px 6px;border-radius:4px;font-family:inherit;font-size:12px;`;
  return input;
}

export function createButtonRow(...buttons: HTMLElement[]): HTMLDivElement {
  const row = document.createElement('div');
  row.className = 'btn-row';
  for (const b of buttons) row.appendChild(b);
  return row;
}

export function createSubGroup(label: string): HTMLDivElement {
  const el = document.createElement('div');
  el.className = 'sub-group';
  el.textContent = label;
  return el;
}
