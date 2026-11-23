// Announcer: short spoken call-outs using the browser's built-in speech
// synthesis, so there is nothing to download. Voice quality depends on the
// device. Lines are short, never queue up, and urgent ones interrupt.
export class Announcer {
  constructor() {
    this.enabled = true;
    this.volume = 0.8;
    this.onTalk = null;
    this.lastLine = '';
    this.lang = 'en';
    this.supported = typeof window !== 'undefined' && 'speechSynthesis' in window && typeof SpeechSynthesisUtterance !== 'undefined';
    this.voice = null;
    this.lastT = 0;
    this.lastPriority = 0;
    this.log = [];
    if (this.supported) {
      this.pickVoice();
      window.speechSynthesis.addEventListener('voiceschanged', () => this.pickVoice());
    }
  }

  setLang(lang) {
    this.lang = lang;
    this.pickVoice();
  }

  pickVoice() {
    if (!this.supported) return;
    const voices = window.speechSynthesis.getVoices();
    const want = this.lang === 'zh' ? 'zh' : this.lang === 'es' ? 'es' : 'en';
    const match = voices.filter((v) => v.lang && v.lang.toLowerCase().startsWith(want));
    // Liveliest first: neural/online voices sound far more excited than the
    // classic system ones, then enhanced local voices, then anything.
    const score = (v) =>
      (/natural|neural|online/i.test(v.name) ? 40 : 0) +
      (/google/i.test(v.name) ? 30 : 0) +
      (/enhanced|premium/i.test(v.name) ? 20 : 0) +
      (/^(aaron|nicky|evan|tom|alex|samantha|ava|zoe|jorge|paulina|monica|ting-ting|meijia)/i.test(v.name) ? 10 : 0) +
      (/en-us|es-mx|es-es|zh-cn/i.test(v.lang) ? 3 : 0) +
      (v.localService ? 1 : 0);
    match.sort((a, b) => score(b) - score(a));
    this.voice = match[0] || null;
  }

  // Pick a line from a "a|b|c" pool, never the same one twice in a row.
  pick(pool) {
    const opts = String(pool).split('|');
    if (opts.length === 1) return opts[0];
    let line;
    let guard = 6;
    do line = opts[Math.floor(Math.random() * opts.length)];
    while (line === this.lastLine && guard-- > 0);
    return line;
  }

  // mood: 'hype' (fast, high, excited), 'urgent' (fast, punchy, lower),
  // 'down' (big "ohhh" for wipeouts), 'count' (crisp countdown).
  // priority: 1 = flavour (dropped if something was said recently), 2 = important, 3 = interrupts.
  say(pool, priority, mood) {
    const text = this.pick(pool);
    this.log.push(text);
    if (this.log.length > 30) this.log.shift();
    if (!this.enabled || !this.supported || this.volume <= 0.01 || !text) return false;
    const p = priority || 1;
    const now = performance.now();
    const synth = window.speechSynthesis;
    const busy = synth.speaking || synth.pending;
    if (p === 1 && (busy || now - this.lastT < 1300)) return false;
    if (p === 2 && busy && this.lastPriority >= 2 && now - this.lastT < 600) return false;
    if (busy && p >= 2) synth.cancel();
    const u = new SpeechSynthesisUtterance(text);
    if (this.voice) u.voice = this.voice;
    u.lang = this.voice ? this.voice.lang : this.lang;
    u.volume = 1;
    const jitter = (Math.random() - 0.5) * 0.12;
    const m = mood || 'hype';
    if (m === 'urgent') {
      u.rate = 1.45;
      u.pitch = 1.05 + jitter;
    } else if (m === 'down') {
      u.rate = 1.15;
      u.pitch = 0.85 + jitter;
    } else if (m === 'count') {
      u.rate = 1.25;
      u.pitch = 1.3;
    } else {
      u.rate = 1.38;
      u.pitch = 1.5 + jitter;
    }
    // Duck the music while the announcer talks.
    u.onstart = () => this.onTalk && this.onTalk(true);
    u.onend = u.onerror = () => this.onTalk && this.onTalk(false);
    this.lastT = now;
    this.lastPriority = p;
    this.lastLine = text;
    try {
      synth.speak(u);
    } catch (err) {
      return false;
    }
    return true;
  }

  stop() {
    if (this.supported) window.speechSynthesis.cancel();
  }
}
