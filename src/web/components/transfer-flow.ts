import { LitElement, html, css } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import "./send-flow";
import "./receive-flow";

@customElement("transfer-flow")
export class TransferFlow extends LitElement {
  @property({ attribute: false }) initialTab: "send" | "receive" = "send";
  @state() private tab: "send" | "receive" = "send";

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
      border-radius: var(--border-radius-md);
      border: 1.5px solid var(--color-accent);
      background: transparent;
      color: var(--color-text-header);
      font-family: inherit;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.02em;
      cursor: pointer;
    }
    button.active {
      border-color: var(--color-accent);
      color: var(--color-text-header);
      box-shadow: inset 0 0 0 1px var(--color-accent);
    }
  `;

  updated(changed: Map<string, unknown>) {
    if (changed.has("initialTab") && this.initialTab) {
      this.tab = this.initialTab;
    }
  }

  render() {
    return html`
      <div class="tabs">
        <button
          class=${this.tab === "send" ? "active" : ""}
          @click=${() => (this.tab = "send")}
        >
          Send money
        </button>
        <button
          class=${this.tab === "receive" ? "active" : ""}
          @click=${() => (this.tab = "receive")}
        >
          Receive money
        </button>
      </div>
      ${this.tab === "send" ? html`<send-flow></send-flow>` : html`<receive-flow></receive-flow>`}
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "transfer-flow": TransferFlow;
  }
}
