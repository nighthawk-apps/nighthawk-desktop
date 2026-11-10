import { LitElement, html, css } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import "./send-flow";
import "./receive-flow";
import "./request-flow";

type TransferTab = "request" | "receive" | "send";

@customElement("transfer-flow")
export class TransferFlow extends LitElement {
  @property({ attribute: false }) initialTab: TransferTab = "receive";
  @state() private tab: TransferTab = "receive";

  static styles = css`
    :host {
      display: block;
      padding: 16px 20px;
    }
    .tabs {
      display: flex;
      gap: 12px;
      margin-bottom: 16px;
    }
    button {
      flex: 1;
      padding: 12px 14px;
      /* Match chat Channels/Direct selected chip (8px, not pill) */
      border-radius: var(--border-radius-md, 8px);
      border: 1px solid color-mix(in srgb, var(--color-accent) 28%, transparent);
      background: transparent;
      color: var(--color-text-header);
      font-family: inherit;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.02em;
      cursor: pointer;
    }
    button.active {
      background: color-mix(in srgb, var(--color-accent) 38%, transparent);
      border-color: color-mix(in srgb, var(--color-accent) 55%, transparent);
      color: var(--color-text-header);
    }
  `;

  updated(changed: Map<string, unknown>) {
    if (changed.has("initialTab") && this.initialTab) {
      this.tab = this.initialTab;
    }
  }

  render() {
    // Wallet hub order: Request → Receive → Send
    return html`
      <div class="tabs">
        <button
          class=${this.tab === "request" ? "active" : ""}
          @click=${() => (this.tab = "request")}
        >
          Request
        </button>
        <button
          class=${this.tab === "receive" ? "active" : ""}
          @click=${() => (this.tab = "receive")}
        >
          Receive
        </button>
        <button
          class=${this.tab === "send" ? "active" : ""}
          @click=${() => (this.tab = "send")}
        >
          Send
        </button>
      </div>
      ${this.tab === "send"
        ? html`<send-flow></send-flow>`
        : this.tab === "request"
          ? html`<request-flow></request-flow>`
          : html`<receive-flow></receive-flow>`}
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "transfer-flow": TransferFlow;
  }
}
