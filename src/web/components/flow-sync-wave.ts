import { LitElement, html, css } from "lit";
import { customElement, property } from "lit/decorators.js";

const SAMPLE_COUNT = 48;
const EMA_ALPHA = 0.35;

/**
 * Lightweight `flow`-inspired mirrored sync waveform canvas.
 * Stops `requestAnimationFrame` whenever `active` is false, tab is hidden,
 * or `prefers-reduced-motion: reduce` is enabled.
 */
@customElement("flow-sync-wave")
export class FlowSyncWave extends LitElement {
  @property({ type: Number }) progress = 0;
  @property({ type: Boolean }) active = false;
  @property({ type: Number }) scannedHeight = 0;

  private upperRing = new Float32Array(SAMPLE_COUNT);
  private lowerRing = new Float32Array(SAMPLE_COUNT);
  private lastScannedHeight = 0;
  private rafId: number | null = null;
  private resizeObserver: ResizeObserver | null = null;
  private lastFrameMs = 0;
  private phase = 0;

  static styles = css`
    :host {
      display: block;
      width: 100%;
      margin-bottom: 6px;
    }
    canvas {
      display: block;
      width: 100%;
      height: 36px;
    }
  `;

  private onVisibilityChange = () => {
    if (document.visibilityState === "visible" && this.active) {
      this.startLoop();
    } else {
      this.stopLoop();
    }
  };

  connectedCallback(): void {
    super.connectedCallback();
    document.addEventListener("visibilitychange", this.onVisibilityChange);
    if (this.active) {
      this.startLoop();
    }
  }

  firstUpdated(): void {
    const canvas = this.renderRoot.querySelector("canvas");
    if (canvas && typeof ResizeObserver !== "undefined") {
      this.resizeObserver = new ResizeObserver(() => this.draw());
      this.resizeObserver.observe(canvas);
    }
  }

  disconnectedCallback(): void {
    document.removeEventListener("visibilitychange", this.onVisibilityChange);
    this.resizeObserver?.disconnect();
    this.resizeObserver = null;
    this.stopLoop();
    super.disconnectedCallback();
  }

  protected updated(changed: Map<PropertyKey, unknown>): void {
    if (changed.has("scannedHeight")) {
      if (this.scannedHeight > this.lastScannedHeight) {
        this.lastScannedHeight = this.scannedHeight;
        this.pulseRing(0.85);
      } else if (this.scannedHeight < this.lastScannedHeight) {
        this.lastScannedHeight = this.scannedHeight;
      }
    }
    if (changed.has("active") || changed.has("progress")) {
      if (this.active && !this.prefersReducedMotion()) {
        this.startLoop();
      } else {
        this.stopLoop();
        this.draw();
      }
    }
  }

  private prefersReducedMotion(): boolean {
    return (
      typeof window !== "undefined" &&
      typeof window.matchMedia === "function" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches
    );
  }

  private pulseRing(impulse: number): void {
    for (let i = 0; i < SAMPLE_COUNT - 1; i++) {
      this.upperRing[i] = this.upperRing[i + 1];
      this.lowerRing[i] = this.lowerRing[i + 1];
    }
    const prevUp = this.upperRing[SAMPLE_COUNT - 2] || 0.25;
    const prevDown = this.lowerRing[SAMPLE_COUNT - 2] || 0.18;
    const nextUp = EMA_ALPHA * impulse + (1 - EMA_ALPHA) * prevUp;
    const nextDown = EMA_ALPHA * (impulse * 0.65) + (1 - EMA_ALPHA) * prevDown;
    this.upperRing[SAMPLE_COUNT - 1] = Math.min(1, Math.max(0.08, nextUp));
    this.lowerRing[SAMPLE_COUNT - 1] = Math.min(0.8, Math.max(0.05, nextDown));
  }

  private startLoop(): void {
    if (this.rafId !== null || this.prefersReducedMotion() || document.visibilityState !== "visible") {
      this.draw();
      return;
    }
    const tick = (now: number) => {
      if (!this.isConnected || !this.active || document.visibilityState !== "visible") {
        this.rafId = null;
        if (this.isConnected) this.draw();
        return;
      }
      if (now - this.lastFrameMs >= 32) {
        this.lastFrameMs = now;
        this.phase = (this.phase + 0.12) % (Math.PI * 2);
        const carrier = 0.42 + 0.28 * Math.sin(this.phase * 2) + 0.15 * Math.cos(this.phase * 3);
        this.pulseRing(carrier);
        this.draw();
      }
      this.rafId = requestAnimationFrame(tick);
    };
    this.rafId = requestAnimationFrame(tick);
  }

  private stopLoop(): void {
    if (this.rafId !== null) {
      cancelAnimationFrame(this.rafId);
      this.rafId = null;
    }
  }

  private draw(): void {
    const canvas = this.renderRoot.querySelector("canvas");
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return;
    const dpr = window.devicePixelRatio || 1;
    const targetW = Math.round(rect.width * dpr);
    const targetH = Math.round(rect.height * dpr);
    if (canvas.width !== targetW || canvas.height !== targetH) {
      canvas.width = targetW;
      canvas.height = targetH;
    }
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    const w = rect.width;
    const h = rect.height;
    const midY = h * 0.5;
    const clamped = Math.min(1, Math.max(0, this.progress));
    ctx.clearRect(0, 0, w, h);

    const cs = getComputedStyle(this);
    const accent = cs.getPropertyValue("--color-accent").trim() || "#f59e0b";
    const muted = cs.getPropertyValue("--color-text-muted").trim() || "#8b92a5";

    ctx.save();
    ctx.strokeStyle = muted;
    ctx.globalAlpha = 0.28;
    ctx.setLineDash([4, 4]);
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, midY);
    ctx.lineTo(w, midY);
    ctx.stroke();
    ctx.restore();

    if (!this.active) {
      if (clamped > 0) {
        ctx.save();
        ctx.strokeStyle = accent;
        ctx.globalAlpha = 0.72;
        ctx.lineWidth = 2;
        ctx.lineCap = "round";
        ctx.beginPath();
        ctx.moveTo(0, midY);
        ctx.lineTo(w * clamped, midY);
        ctx.stroke();
        ctx.restore();
      }
      return;
    }

    const maxAmp = Math.max(4, h * 0.42);
    const activeFrac = Math.max(0.18, clamped);

    ctx.save();
    const upGrad = ctx.createLinearGradient(0, midY - maxAmp, 0, midY);
    upGrad.addColorStop(0, accent);
    upGrad.addColorStop(1, "transparent");

    ctx.beginPath();
    ctx.moveTo(0, midY);
    for (let i = 0; i < SAMPLE_COUNT; i++) {
      const u = i / (SAMPLE_COUNT - 1);
      const x = w * u;
      const env = u <= activeFrac ? 0.35 + 0.65 * Math.sin((Math.PI * u) / activeFrac) : 0.14;
      const sample = this.upperRing[i] || 0.25 + 0.15 * Math.sin(u * 11 - this.phase);
      ctx.lineTo(x, midY - sample * maxAmp * env);
    }
    ctx.lineTo(w, midY);
    ctx.closePath();
    ctx.globalAlpha = 0.36;
    ctx.fillStyle = upGrad;
    ctx.fill();

    ctx.beginPath();
    for (let i = 0; i < SAMPLE_COUNT; i++) {
      const u = i / (SAMPLE_COUNT - 1);
      const x = w * u;
      const env = u <= activeFrac ? 0.35 + 0.65 * Math.sin((Math.PI * u) / activeFrac) : 0.14;
      const sample = this.upperRing[i] || 0.25 + 0.15 * Math.sin(u * 11 - this.phase);
      const y = midY - sample * maxAmp * env;
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.globalAlpha = 0.9;
    ctx.strokeStyle = accent;
    ctx.lineWidth = 1.6;
    ctx.stroke();

    const lowGrad = ctx.createLinearGradient(0, midY, 0, midY + maxAmp);
    lowGrad.addColorStop(0, "transparent");
    lowGrad.addColorStop(1, muted);
    ctx.beginPath();
    ctx.moveTo(0, midY);
    for (let i = 0; i < SAMPLE_COUNT; i++) {
      const u = i / (SAMPLE_COUNT - 1);
      const x = w * u;
      const env = u <= activeFrac ? 0.35 + 0.65 * Math.sin((Math.PI * u) / activeFrac) : 0.14;
      const sample = this.lowerRing[i] || 0.2 + 0.12 * Math.cos(u * 9 + this.phase);
      ctx.lineTo(x, midY + sample * maxAmp * 0.72 * env);
    }
    ctx.lineTo(w, midY);
    ctx.closePath();
    ctx.globalAlpha = 0.24;
    ctx.fillStyle = lowGrad;
    ctx.fill();

    const tickX = Math.min(w - 2, Math.max(2, w * activeFrac));
    ctx.globalAlpha = 0.95;
    ctx.strokeStyle = accent;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(tickX, midY - maxAmp * 0.65);
    ctx.lineTo(tickX, midY + maxAmp * 0.45);
    ctx.stroke();
    ctx.restore();
  }

  render() {
    return html`<canvas aria-hidden="true"></canvas>`;
  }
}
