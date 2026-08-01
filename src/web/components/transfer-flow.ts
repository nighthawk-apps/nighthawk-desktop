import { LitElement, html, css } from "lit";
import { customElement, state } from "lit/decorators.js";
import { api } from "../lib/api";
import "./send-flow";
import "./receive-flow";

@customElement("transfer-flow")
export class TransferFlow extends LitElement {
  @state() private tab: "send" | "receive" = "send";

  static styles = css`
    :host {
      display: block;
      padding: 16px 20px;
    }
    .tabs {
      display: flex;
      gap: 8px;
      margin-bottom: 16px;
    }
    button {
      flex: 1;
      padding: 10px;
      border-radius: var(--border-radius-md);
      border: 1px solid var(--color-steel-border);
      background: var(--color-elevated);
      color: var(--color-text-body);
      font-family: inherit;
      cursor: pointer;
    }
    button.active {
      background: var(--color-accent-subtle-container);
      color: var(--color-accent);
      border-color: var(--color-accent-deep);
    }
  `;

  render() {
    return html`
      <div class="tabs">
        <button
          class=${this.tab === "send" ? "active" : ""}
          @click=${() => (this.tab = "send")}
        >
          Send
        </button>
        <button
          class=${this.tab === "receive" ? "active" : ""}
          @click=${() => (this.tab = "receive")}
        >
          Receive
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
