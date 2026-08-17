/*
 * Copyright (c) 2026 Nighthawk Apps
 * All rights reserved.
 */

import { LitElement, html, css } from "lit";
import { customElement, state } from "lit/decorators.js";
import {
  api,
  type DaoProposalSummary,
  type DaoSummary,
} from "../lib/api";

@customElement("dao-screen")
export class DaoScreen extends LitElement {
  @state() private daos: DaoSummary[] = [];
  @state() private proposals: DaoProposalSummary[] = [];
  @state() private selectedDao = "";
  @state() private proposeAmount = "";
  @state() private proposeRecipient = "";
  @state() private proposeDuration = "10";
  @state() private proposeTokenId = "";
  @state() private showProposeModal = false;
  @state() private message = "";
  @state() private error = "";
  @state() private loading = false;
  @state() private votingProposal: string | null = null;

  static styles = css`
    :host {
      display: block;
      padding: 20px;
    }
    .header-row {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 20px;
    }
    h2 {
      margin: 0;
      font-size: var(--font-size-2xl);
      color: var(--color-text-header);
    }
    .card {
      background: var(--color-charcoal-raised);
      border: 1px solid var(--color-steel-border-muted);
      border-radius: var(--border-radius-lg);
      padding: 16px;
      margin-bottom: 16px;
    }
    .dao-header {
      display: flex;
      justify-content: space-between;
      align-items: baseline;
      margin-bottom: 8px;
    }
    .dao-name {
      font-size: var(--font-size-lg);
      font-weight: 700;
      color: var(--color-text-header);
    }
    .dao-bulla {
      font-family: var(--font-family-mono, monospace);
      font-size: var(--font-size-xs);
      color: var(--color-text-muted);
      word-break: break-all;
    }
    .stats-row {
      display: flex;
      gap: 16px;
      margin: 12px 0;
      font-size: var(--font-size-sm);
      color: var(--color-text-muted);
    }
    .stat-val {
      font-weight: 600;
      color: var(--color-text-header);
    }
    .progress-bar {
      height: 6px;
      background: var(--color-elevated);
      border-radius: 999px;
      overflow: hidden;
      margin: 8px 0;
    }
    .progress-fill {
      height: 100%;
      background: var(--color-accent);
      border-radius: 999px;
      transition: width var(--transition-fast, 0.2s ease);
    }
    .actions-row {
      display: flex;
      gap: 8px;
      margin-top: 12px;
    }
    button {
      padding: 8px 14px;
      border: none;
      border-radius: var(--border-radius-md);
      background: var(--color-accent);
      color: var(--color-on-accent);
      font-weight: 600;
      font-size: var(--font-size-sm);
      cursor: pointer;
      font-family: inherit;
      transition: opacity var(--transition-fast, 0.2s);
    }
    button:disabled {
      opacity: 0.5;
      cursor: not-allowed;
    }
    button.secondary {
      background: var(--color-secondary-fill);
      color: var(--color-text-header);
      border: 1px solid var(--color-steel-border);
    }
    button.small {
      padding: 6px 12px;
      font-size: var(--font-size-xs);
    }
    button.vote-yes {
      background: #2e7d32;
      color: #fff;
    }
    button.vote-no {
      background: #c62828;
      color: #fff;
    }
    .proposal-card {
      background: var(--color-elevated);
      border: 1px solid var(--color-steel-border);
      border-radius: var(--border-radius-md);
      padding: 12px 14px;
      margin-top: 10px;
    }
    .proposal-summary {
      font-size: var(--font-size-sm);
      color: var(--color-text-header);
      margin-bottom: 6px;
    }
    .proposal-bulla {
      font-family: var(--font-family-mono, monospace);
      font-size: var(--font-size-xs);
      color: var(--color-text-muted);
      word-break: break-all;
    }
    .badge {
      display: inline-block;
      padding: 2px 8px;
      border-radius: 999px;
      font-size: var(--font-size-xs);
      font-weight: 600;
      text-transform: uppercase;
    }
    .badge.executed {
      background: rgba(46, 125, 50, 0.2);
      color: #66bb6a;
    }
    .badge.active {
      background: rgba(25, 118, 210, 0.2);
      color: #42a5f5;
    }
    .badge.pending {
      background: rgba(239, 108, 0, 0.2);
      color: #ffa726;
    }
    .modal-overlay {
      position: fixed;
      top: 0;
      left: 0;
      right: 0;
      bottom: 0;
      background: rgba(0, 0, 0, 0.7);
      display: flex;
      align-items: center;
      justify-content: center;
      z-index: 100;
      padding: 20px;
    }
    .modal {
      background: var(--color-charcoal-raised);
      border: 1px solid var(--color-steel-border);
      border-radius: var(--border-radius-lg);
      padding: 24px;
      max-width: 480px;
      width: 100%;
      box-sizing: border-box;
    }
    .modal h3 {
      margin: 0 0 16px;
      color: var(--color-text-header);
    }
    label {
      display: block;
      margin-top: 12px;
      font-size: var(--font-size-sm);
      color: var(--color-text-muted);
    }
    input {
      width: 100%;
      box-sizing: border-box;
      margin-top: 6px;
      padding: 10px 12px;
      border-radius: var(--border-radius-md);
      border: 1px solid var(--color-steel-border);
      background: var(--color-elevated);
      color: var(--color-text-header);
      font-family: inherit;
    }
    .modal-actions {
      display: flex;
      justify-content: flex-end;
      gap: 8px;
      margin-top: 20px;
    }
    .msg {
      padding: 8px 12px;
      border-radius: var(--border-radius-md);
      background: rgba(76, 175, 80, 0.1);
      border: 1px solid rgba(76, 175, 80, 0.3);
      color: #81c784;
      font-size: var(--font-size-sm);
      margin-bottom: 16px;
      word-break: break-all;
    }
    .err {
      padding: 8px 12px;
      border-radius: var(--border-radius-md);
      background: rgba(244, 67, 54, 0.1);
      border: 1px solid rgba(244, 67, 54, 0.3);
      color: #e57373;
      font-size: var(--font-size-sm);
      margin-bottom: 16px;
    }
    .empty {
      text-align: center;
      padding: 40px 20px;
      color: var(--color-text-muted);
    }
  `;

  async connectedCallback() {
    super.connectedCallback();
    await this.refreshDaos();
  }

  private async refreshDaos() {
    this.loading = true;
    this.error = "";
    try {
      this.daos = await api.listDaos();
      if (this.daos.length > 0 && !this.selectedDao) {
        this.selectedDao = this.daos[0].name;
        await this.loadProposals(this.selectedDao);
      }
    } catch (e: unknown) {
      this.error = String(e);
    } finally {
      this.loading = false;
    }
  }

  private async loadProposals(daoName: string) {
    this.selectedDao = daoName;
    try {
      this.proposals = await api.listProposals(daoName);
    } catch (e: unknown) {
      this.error = String(e);
    }
  }

  private async vote(bulla: string, yes: boolean) {
    this.votingProposal = bulla;
    this.error = "";
    this.message = "";
    try {
      const tx = await api.daoVote(bulla, yes);
      this.message = `Vote broadcast: ${tx}`;
      if (this.selectedDao) {
        await this.loadProposals(this.selectedDao);
      }
    } catch (e: unknown) {
      this.error = String(e);
    } finally {
      this.votingProposal = null;
    }
  }

  private async proposeTransfer() {
    if (!this.selectedDao || !this.proposeAmount.trim() || !this.proposeRecipient.trim()) {
      this.error = "Please fill in amount and recipient address";
      return;
    }
    this.loading = true;
    this.error = "";
    this.message = "";
    try {
      const tx = await api.daoProposeTransfer({
        daoName: this.selectedDao,
        durationBlockwindows: Number(this.proposeDuration) || 10,
        amount: this.proposeAmount.trim(),
        tokenId: this.proposeTokenId.trim() || undefined,
        recipientAddress: this.proposeRecipient.trim(),
      });
      this.message = `Proposal created: ${tx}`;
      this.showProposeModal = false;
      this.proposeAmount = "";
      this.proposeRecipient = "";
      await this.loadProposals(this.selectedDao);
    } catch (e: unknown) {
      this.error = String(e);
    } finally {
      this.loading = false;
    }
  }

  render() {
    return html`
      <div class="header-row">
        <h2>DAO Hub</h2>
        <button class="secondary" ?disabled=${this.loading} @click=${this.refreshDaos}>
          ${this.loading ? "Refreshing…" : "Refresh DAOs"}
        </button>
      </div>

      ${this.message ? html`<div class="msg">${this.message}</div>` : null}
      ${this.error ? html`<div class="err">${this.error}</div>` : null}

      ${this.daos.length === 0
        ? html`
            <div class="card empty">
              <p>No DAOs imported in this wallet yet.</p>
              <p style="font-size: var(--font-size-xs)">
                Import DAOs via DarkFi CLI (<code>drk dao list</code>) or participating in governance.
              </p>
            </div>
          `
        : this.daos.map((dao) => this.renderDaoCard(dao))}

      ${this.showProposeModal ? this.renderProposeModal() : null}
    `;
  }

  private renderDaoCard(dao: DaoSummary) {
    const isSelected = this.selectedDao === dao.name;
    return html`
      <div class="card">
        <div class="dao-header">
          <span class="dao-name">${dao.name}</span>
          <span class="dao-bulla">${dao.bullaB58.slice(0, 16)}…</span>
        </div>

        <div class="stats-row">
          <div>
            Quorum: <span class="stat-val">${dao.quorumDisplay}</span>
          </div>
          <div>
            Proposer limit: <span class="stat-val">${dao.proposerLimitDisplay}</span>
          </div>
          <div>
            Approval: <span class="stat-val">${dao.approvalRatioPercent.toFixed(1)}%</span>
          </div>
        </div>

        <div class="progress-bar">
          <div
            class="progress-fill"
            style="width: ${Math.min(100, Math.max(0, dao.approvalRatioPercent))}%"
          ></div>
        </div>

        <div class="actions-row">
          <button
            class="secondary small"
            @click=${() => this.loadProposals(dao.name)}
          >
            ${isSelected ? "Refresh Proposals" : "View Proposals"}
          </button>
          <button
            class="small"
            @click=${() => {
              this.selectedDao = dao.name;
              this.showProposeModal = true;
            }}
          >
            Propose Transfer
          </button>
        </div>

        ${isSelected ? this.renderProposalsList() : null}
      </div>
    `;
  }

  private renderProposalsList() {
    if (this.proposals.length === 0) {
      return html`
        <div style="margin-top: 12px; font-size: var(--font-size-sm); color: var(--color-text-muted)">
          No active proposals for ${this.selectedDao}.
        </div>
      `;
    }

    return html`
      <div style="margin-top: 16px">
        <h4 style="margin: 0 0 8px; color: var(--color-text-header)">
          ${this.selectedDao} Proposals (${this.proposals.length})
        </h4>
        ${this.proposals.map((p) => this.renderProposal(p))}
      </div>
    `;
  }

  private renderProposal(p: DaoProposalSummary) {
    const statusClass = p.isExecuted ? "executed" : p.mintHeight > 0 ? "active" : "pending";
    const statusLabel = p.isExecuted ? "Executed" : p.mintHeight > 0 ? "Active" : "Pending";
    const isVoting = this.votingProposal === p.proposalBullaB58;

    return html`
      <div class="proposal-card">
        <div style="display: flex; justify-content: space-between; align-items: baseline; margin-bottom: 4px">
          <span class="badge ${statusClass}">${statusLabel}</span>
          <span class="proposal-bulla">${p.proposalBullaB58.slice(0, 16)}…</span>
        </div>
        <div class="proposal-summary">${p.summaryLine || "Transfer Proposal"}</div>
        <div style="font-size: var(--font-size-xs); color: var(--color-text-muted); margin-bottom: 8px">
          Duration: ${p.durationBlockwindows} block windows · Calls: ${p.authCallCount}
        </div>
        ${!p.isExecuted
          ? html`
              <div class="actions-row">
                <button
                  class="vote-yes small"
                  ?disabled=${isVoting}
                  @click=${() => this.vote(p.proposalBullaB58, true)}
                >
                  ${isVoting ? "Voting…" : "Vote YES"}
                </button>
                <button
                  class="vote-no small"
                  ?disabled=${isVoting}
                  @click=${() => this.vote(p.proposalBullaB58, false)}
                >
                  ${isVoting ? "Voting…" : "Vote NO"}
                </button>
              </div>
            `
          : null}
      </div>
    `;
  }

  private renderProposeModal() {
    return html`
      <div class="modal-overlay" @click=${(e: Event) => {
        if (e.target === e.currentTarget) this.showProposeModal = false;
      }}>
        <div class="modal">
          <h3>Propose Transfer — ${this.selectedDao}</h3>

          <label>Amount (DRK or atomic token)</label>
          <input
            placeholder="e.g. 10.5"
            .value=${this.proposeAmount}
            @input=${(e: Event) => (this.proposeAmount = (e.target as HTMLInputElement).value)}
          />

          <label>Recipient Address</label>
          <input
            placeholder="drk1..."
            .value=${this.proposeRecipient}
            @input=${(e: Event) => (this.proposeRecipient = (e.target as HTMLInputElement).value)}
          />

          <label>Duration (block windows, default 10)</label>
          <input
            type="number"
            .value=${this.proposeDuration}
            @input=${(e: Event) => (this.proposeDuration = (e.target as HTMLInputElement).value)}
          />

          <label>Token ID (optional, empty for native DRK)</label>
          <input
            placeholder="Optional custom token ID"
            .value=${this.proposeTokenId}
            @input=${(e: Event) => (this.proposeTokenId = (e.target as HTMLInputElement).value)}
          />

          <div class="modal-actions">
            <button class="secondary" @click=${() => (this.showProposeModal = false)}>
              Cancel
            </button>
            <button ?disabled=${this.loading} @click=${this.proposeTransfer}>
              ${this.loading ? "Proposing…" : "Submit Proposal"}
            </button>
          </div>
        </div>
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "dao-screen": DaoScreen;
  }
}
