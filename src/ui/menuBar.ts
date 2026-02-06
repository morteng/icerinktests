export type MenuTab = 'scene' | 'environment' | 'rendering' | 'tools' | 'sim' | 'session';

const TABS: { id: MenuTab; label: string }[] = [
  { id: 'scene', label: 'Scene' },
  { id: 'environment', label: 'Environment' },
  { id: 'rendering', label: 'Rendering' },
  { id: 'tools', label: 'Tools' },
  { id: 'sim', label: 'Sim' },
  { id: 'session', label: 'Session' },
];

export class MenuBar {
  readonly el: HTMLDivElement;
  private buttons = new Map<MenuTab, HTMLButtonElement>();
  private _active: MenuTab = 'scene';
  onTabChange: ((tab: MenuTab) => void) | null = null;

  constructor() {
    this.el = document.createElement('div');
    this.el.id = 'menu-bar';

    // Title
    const title = document.createElement('span');
    title.className = 'menu-title';
    title.textContent = 'ICE SIM';
    this.el.appendChild(title);

    for (const tab of TABS) {
      const btn = document.createElement('button');
      btn.className = 'menu-tab';
      btn.textContent = tab.label;
      btn.dataset.tab = tab.id;
      if (tab.id === this._active) btn.classList.add('active');
      btn.addEventListener('click', () => this.setActive(tab.id));
      this.el.appendChild(btn);
      this.buttons.set(tab.id, btn);
    }

    // WebGPU badge
    const badge = document.createElement('span');
    badge.className = 'menu-badge';
    badge.textContent = 'WebGPU';
    this.el.appendChild(badge);
  }

  setActive(tab: MenuTab) {
    if (tab === this._active) return;
    this.buttons.get(this._active)?.classList.remove('active');
    this._active = tab;
    this.buttons.get(tab)?.classList.add('active');
    this.onTabChange?.(tab);
  }

  get active(): MenuTab { return this._active; }
}
