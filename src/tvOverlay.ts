/**
 * TV Broadcast lower-thirds overlay with Norwegian commentary.
 * Shows contextual commentary about ice damage, skaters, zamboni, etc.
 */

export type CommentaryContext = 'damage' | 'zamboni' | 'skaters' | 'goal_area' | 'general' | 'quality';

interface CommentaryLine {
  context: CommentaryContext;
  title: string;   // Bold headline
  body: string;    // Detail text
}

// Pre-canned Norwegian commentary — ice rink maintenance parody
// Tongue-in-cheek sports commentary focused entirely on ice quality,
// rink workers, and how skaters are treating the precious surface.
const COMMENTARY: CommentaryLine[] = [
  // === DAMAGE — skaters destroying our masterpiece ===
  { context: 'damage', title: 'Hærverk i midtsonen',
    body: 'Se på den oppskrapningen. Timer med preparering — ødelagt på sekunder.' },
  { context: 'damage', title: 'Isen gråter',
    body: 'Den overflaten var perfekt for ti minutter siden. Nå ser det ut som en grusplass.' },
  { context: 'damage', title: 'Brutalt hockeystopp',
    body: 'Den spilleren bremset som om isen er gratis. Det er den ikke.' },
  { context: 'damage', title: 'Katastrofe ved vantet',
    body: 'Snøsørpe samler seg langs kanten. Banemesteren rister på hodet backstage.' },
  { context: 'damage', title: 'Skadeomfang: Kritisk',
    body: 'Hvis isen kunne snakke, hadde den bedt om ambulanse nå.' },
  { context: 'damage', title: 'Respektløs skøyting',
    body: 'Null respekt for overflaten. Banemesteren fortjener bedre enn dette.' },
  { context: 'damage', title: 'Slitasje ute av kontroll',
    body: 'Spon og skrapmerker overalt. Ismaskinen trengs desperat.' },
  { context: 'damage', title: 'Foran målet igjen',
    body: 'Keepersonen er nå offisielt en krigssone. Stakkars is.' },
  { context: 'damage', title: 'Knivskarp analyse',
    body: 'Med litt velvilje kan man kalle dette «karakteristisk slitasje». Med ærlighet: en skandale.' },
  { context: 'damage', title: 'Uheldig utvikling',
    body: 'Isen begynner å ligne en parkeringsplass i april. Ikke ideelt.' },

  // === ZAMBONI — the hero arrives ===
  { context: 'zamboni', title: 'Helten ankommer',
    body: 'Der er den! Ismaskinen ruller inn. Publikum burde reise seg.' },
  { context: 'zamboni', title: 'Kunstneren i arbeid',
    body: 'Se den presisjonen. Millimeterperfekt vannlag. Mesterlig håndverk.' },
  { context: 'zamboni', title: 'Redningsaksjon',
    body: 'Etter det spillerne har gjort med isen, er dette nærmest en nødoperasjon.' },
  { context: 'zamboni', title: 'Profesjonell preparering',
    body: 'Varmt vann, riktig mengde, perfekt hastighet. Lærebokarbeid.' },
  { context: 'zamboni', title: 'Overflaten gjenoppstår',
    body: 'Fra slagmark til speilblank. Banemesteren leverer igjen.' },
  { context: 'zamboni', title: 'Siste passering',
    body: 'Nesten ferdig. Snart står den der igjen — perfekt og sårbar.' },
  { context: 'zamboni', title: 'Stående applaus',
    body: 'Denne prepareringen fortjener en egen pris. Absolutt toppklasse.' },
  { context: 'zamboni', title: 'Banemesteren leverer',
    body: 'Jevnt, blankt, feilfritt. Noen kaller det jobb. Vi kaller det kunst.' },

  // === SKATERS — the enemy of good ice ===
  { context: 'skaters', title: 'Invasjonen begynner',
    body: 'Spillerne er tilbake på isen. Banemesteren puster tungt bak glasset.' },
  { context: 'skaters', title: 'Isen lider',
    body: 'Hvert eneste stopp sender spon flygende. Overflaten protesterer.' },
  { context: 'skaters', title: 'Hensynsløs ferdsel',
    body: 'De skøyter som om isen vokser på trær. Nyhetsflash: det gjør den ikke.' },
  { context: 'skaters', title: 'Aggressiv svingkjøring',
    body: 'Flotte buer, sure skøytemerker. Banemesteren gråter innvendig.' },
  { context: 'skaters', title: 'Spillerne vs. isen',
    body: 'Tolv spillere mot én isflate. Isen taper. Den taper alltid.' },
  { context: 'skaters', title: 'Treningsintensitet',
    body: 'Høy innsats fra laget i dag. Dessverre også høy skade på isen.' },
  { context: 'skaters', title: 'Sponproduksjon',
    body: 'Imponerende mengder isspon generert per minutt. Ny rekord?' },
  { context: 'skaters', title: 'Ulovlig bremsing?',
    body: 'Den bremsingen burde vært straffbart. To minutter for mishandling av isflaten.' },
  { context: 'skaters', title: 'En tanke for isen',
    body: 'Ingen av disse spillerne har noensinne preparert is selv. Det merkes.' },
  { context: 'skaters', title: 'Skøytemerkenes tale',
    body: 'Hver ripe forteller en historie. Og det er ingen av dem som er hyggelige.' },

  // === GENERAL — overall ice condition commentary ===
  { context: 'general', title: 'Banerapport',
    body: 'Overflaten holder seg... foreløpig. Men presset øker minutt for minutt.' },
  { context: 'general', title: 'Kjøleanlegget',
    body: 'Rørene jobber hardt i dag. Minus syv under overflaten. Akkurat som bestilt.' },
  { context: 'general', title: 'Temperatursjekk',
    body: 'Stabil istemperatur. I det minste er kjøleanlegget på vår side i kveld.' },
  { context: 'general', title: 'Iskvalitetsindeks',
    body: 'Vi ligger fortsatt innenfor toleransen, men marginene krymper.' },
  { context: 'general', title: 'Fugtighetskontroll',
    body: 'Luftfuktigheten er under kontroll. Ingen uønsket kondens i dag.' },
  { context: 'general', title: 'Istykkelse OK',
    body: 'Jevn tykkelse over hele banen. Grunnarbeidet var solid.' },

  // === QUALITY — praising or criticizing the rink crew ===
  { context: 'quality', title: 'Toppkarakter til banemester',
    body: 'Denne isflaten er et kunstverk. Klart det fortjener en Michelin-stjerne.' },
  { context: 'quality', title: 'Verdensklasse preparering',
    body: 'Er dette den beste isen i landet? Vi tør påstå ja.' },
  { context: 'quality', title: 'Forbedringspotensial',
    body: 'La oss si det diplomatisk: det er rom for utvikling her.' },
  { context: 'quality', title: 'Under lupen',
    body: 'Eksperthensyn avslører mikroriper i tredje sone. Banemesteren bør notere seg.' },
  { context: 'quality', title: 'Banemesterens signatur',
    body: 'Man kjenner igjen godt håndverk. Denne overflaten har signatur.' },
  { context: 'quality', title: 'Anlegget imponerer',
    body: 'Moderne kjøleteknikk møter gammeldags stolthet. Resultatet taler for seg.' },
  { context: 'quality', title: 'Helt ærlig?',
    body: 'Isen har sett bedre dager. Men hvem har vel ikke det.' },
  { context: 'quality', title: 'Proffnivå',
    body: 'Isflaten er klar for internasjonal konkurranse. Respekt til mannskapet.' },
];

export class TVOverlay {
  private container: HTMLDivElement;
  private titleEl: HTMLDivElement;
  private bodyEl: HTMLDivElement;
  private visible = false;
  private showTimer = 0;
  private hideTimer = 0;
  private currentDuration = 0;
  private lastContext: CommentaryContext | null = null;
  private lastIndex = -1;
  private cooldownTimer = 0;

  constructor(parent: HTMLElement) {
    this.container = document.createElement('div');
    this.container.className = 'tv-lower-third';
    this.container.style.cssText = `
      position: absolute;
      bottom: 48px;
      left: 24px;
      max-width: 420px;
      background: linear-gradient(135deg, rgba(10,10,30,0.92) 0%, rgba(20,20,50,0.88) 100%);
      border-left: 3px solid #4a7fff;
      padding: 10px 16px;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
      color: #e8e8f0;
      opacity: 0;
      transform: translateX(-20px);
      transition: opacity 0.5s ease, transform 0.5s ease;
      pointer-events: none;
      z-index: 100;
      border-radius: 0 4px 4px 0;
      box-shadow: 0 2px 12px rgba(0,0,0,0.5);
    `;

    this.titleEl = document.createElement('div');
    this.titleEl.style.cssText = `
      font-weight: 700;
      font-size: 13px;
      letter-spacing: 0.5px;
      text-transform: uppercase;
      color: #8ab4ff;
      margin-bottom: 3px;
    `;

    this.bodyEl = document.createElement('div');
    this.bodyEl.style.cssText = `
      font-size: 12px;
      line-height: 1.4;
      color: #c8c8d8;
    `;

    this.container.appendChild(this.titleEl);
    this.container.appendChild(this.bodyEl);
    parent.appendChild(this.container);
  }

  /** Update each frame. dt in seconds. */
  update(dt: number, context: CommentaryContext, active: boolean) {
    if (!active) {
      this.hide();
      return;
    }

    this.cooldownTimer -= dt;

    if (this.visible) {
      this.showTimer += dt;
      if (this.showTimer >= this.currentDuration) {
        this.hide();
        this.cooldownTimer = 3 + Math.random() * 4; // 3-7s between cards
      }
    } else {
      this.hideTimer += dt;
      if (this.cooldownTimer <= 0 && this.hideTimer > 1) {
        this.show(context);
      }
    }
  }

  private show(context: CommentaryContext) {
    // Pick a line matching context (or general fallback)
    const candidates = COMMENTARY.filter(c =>
      c.context === context || c.context === 'general' || c.context === 'quality'
    );
    // Prefer context-specific lines (70% chance)
    const specific = candidates.filter(c => c.context === context);
    let pool = specific.length > 0 && Math.random() < 0.7 ? specific : candidates;

    // Don't repeat the same line
    if (pool.length > 1) {
      pool = pool.filter((_, i) => {
        const globalIdx = COMMENTARY.indexOf(pool[i]);
        return globalIdx !== this.lastIndex;
      });
    }

    const line = pool[Math.floor(Math.random() * pool.length)];
    this.lastIndex = COMMENTARY.indexOf(line);
    this.lastContext = line.context;

    this.titleEl.textContent = line.title;
    this.bodyEl.textContent = line.body;

    this.visible = true;
    this.showTimer = 0;
    this.currentDuration = 5 + Math.random() * 3; // 5-8 seconds visible

    // Animate in
    this.container.style.opacity = '1';
    this.container.style.transform = 'translateX(0)';
  }

  private hide() {
    if (!this.visible) return;
    this.visible = false;
    this.hideTimer = 0;
    this.container.style.opacity = '0';
    this.container.style.transform = 'translateX(-20px)';
  }

  destroy() {
    this.container.remove();
  }
}
