/*
 * Copyright (c) 2026 Nighthawk Apps
 * All rights reserved.
 */

import { LitElement, html, css } from "lit";
import { customElement, state } from "lit/decorators.js";
import {
  api,
  formatInvokeError,
  type DaoProposalSummary,
  type DaoSummary,
} from "../lib/api";
import { isValidDrkAmount } from "../lib/amount";
import { t } from "../i18n";

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
  @state() private showCreateModal = false;
  @state() private createName = "";
  @state() private createGovTokenId = "DRK";
  @state() private createProposerLimit = "1";
  @state() private createQuorum = "10";
  @state() private createEarlyExecQuorum = "";
  @state() private createApprovalRatio = "0.5";
  @state() private showImportModal = false;
  @state() private importName = "";
  @state() private importToml = "";
  @state() private showFundModal = false;
  @state() private fundDaoName = "";
  @state() private fundAmount = "";
  @state() private fundTokenId = "";
  @state() private showExportModal = false;
  @state() private exportDaoName = "";
  @state() private exportRole = "voter";
  @state() private exportedToml = "";
  @state() private treasuryByDao: Record<string, string> = {};
  @state() private message = "";
  @state() private error = "";
  @state() private loading = false;
  @state() private votingProposal: string | null = null;
  @state() private executingProposal: string | null = null;
  @state() private localeTick = 0;
  private tomlClipClearTimer?: number;

  private onLocale = () => {
    this.localeTick++;
  };

  override disconnectedCallback() {
    super.disconnectedCallback();
    window.removeEventListener("nh-locale-changed", this.onLocale);
    if (this.tomlClipClearTimer) {
      clearTimeout(this.tomlClipClearTimer);
      this.tomlClipClearTimer = undefined;
    }
    this.exportedToml = "";
  }

  static styles = css`
    :host {
      display: block;
      padding: 20px;
    }
    .header-row {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 16px;
    }
    /* Match settings-screen .screen-title (Dex/Settings hub title language). */
    h2.screen-title {
      margin: 0;
      font-family: var(--font-family-display);
      font-size: var(--font-size-xl);
      font-weight: 600;
      letter-spacing: 0.04em;
      text-transform: uppercase;
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
      flex-wrap: wrap;
    }
    .roles-row {
      display: flex;
      gap: 6px;
      margin-top: 8px;
      flex-wrap: wrap;
    }
    .role-chip {
      font-size: var(--font-size-xs);
      padding: 2px 8px;
      border-radius: 999px;
      border: 1px solid var(--color-steel-border);
      color: var(--color-text-muted);
    }
    .role-chip.enabled {
      border-color: var(--color-accent);
      color: var(--color-accent-muted);
    }
    .treasury-box {
      margin-top: 10px;
      padding: 8px 10px;
      border-radius: var(--border-radius-md);
      background: var(--color-elevated);
      border: 1px solid var(--color-steel-border);
      font-family: var(--font-family-mono, monospace);
      font-size: var(--font-size-xs);
      white-space: pre-wrap;
      color: var(--color-text-body);
    }
    textarea,
    select {
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
    window.addEventListener("nh-locale-changed", this.onLocale);
    await this.refreshDaos();
  }

  private async refreshDaos() {
    this.loading = true;
    this.error = "";
    try {
      this.daos = await api.listDaos();
      if (this.daos.length > 0 && !this.selectedDao) {
        this.selectedDao = this.daos[0].name;
      }
      if (this.selectedDao && this.daos.some((d) => d.name === this.selectedDao)) {
        await this.loadProposals(this.selectedDao);
      } else {
        this.proposals = [];
      }
    } catch (e: unknown) {
      this.error = formatInvokeError(e);
    } finally {
      this.loading = false;
    }
  }

  private async loadProposals(daoName: string) {
    this.selectedDao = daoName;
    try {
      this.proposals = await api.listProposals(daoName);
    } catch (e: unknown) {
      this.error = formatInvokeError(e);
    }
  }

  private async loadTreasury(daoName: string) {
    this.error = "";
    try {
      const text = await api.daoTreasury(daoName);
      this.treasuryByDao = {
        ...this.treasuryByDao,
        [daoName]: text.trim() || t("dao.treasury_empty"),
      };
    } catch (e: unknown) {
      this.error = formatInvokeError(e);
    }
  }

  private async createDao() {
    const name = this.createName.trim();
    const govTokenId = this.createGovTokenId.trim() || "DRK";
    const ratio = Number(this.createApprovalRatio);
    if (!name) {
      this.error = t("dao.err_name");
      return;
    }
    if (!isValidDrkAmount(this.createProposerLimit) || !isValidDrkAmount(this.createQuorum)) {
      this.error = t("dao.err_limits");
      return;
    }
    if (this.createEarlyExecQuorum.trim() && !isValidDrkAmount(this.createEarlyExecQuorum)) {
      this.error = t("dao.err_early_exec");
      return;
    }
    if (!Number.isFinite(ratio) || ratio <= 0 || ratio > 1) {
      this.error = t("dao.err_ratio");
      return;
    }
    this.loading = true;
    this.error = "";
    this.message = "";
    try {
      const created = await api.daoCreate({
        name,
        proposerLimit: this.createProposerLimit.trim(),
        quorum: this.createQuorum.trim(),
        earlyExecQuorum: this.createEarlyExecQuorum.trim(),
        approvalRatio: ratio,
        govTokenId,
      });
      this.message = t("dao.created_msg", { name: created });
      this.showCreateModal = false;
      this.createName = "";
      this.selectedDao = created;
      await this.refreshDaos();
    } catch (e: unknown) {
      this.error = formatInvokeError(e);
    } finally {
      this.loading = false;
    }
  }

  private async importDao() {
    if (!this.importName.trim() || !this.importToml.trim()) {
      this.error = t("dao.err_import_fields");
      return;
    }
    this.loading = true;
    this.error = "";
    this.message = "";
    try {
      const res = await api.daoImport(this.importName.trim(), this.importToml.trim());
      this.message = t("dao.imported_msg", { name: res });
      this.showImportModal = false;
      this.importName = "";
      this.importToml = "";
      await this.refreshDaos();
    } catch (e: unknown) {
      this.error = formatInvokeError(e);
    } finally {
      this.loading = false;
    }
  }

  private async fundDao() {
    if (!this.fundDaoName || !isValidDrkAmount(this.fundAmount)) {
      this.error = t("dao.err_fund_amount");
      return;
    }
    this.loading = true;
    this.error = "";
    this.message = "";
    try {
      const tx = await api.daoFund({
        daoName: this.fundDaoName,
        amount: this.fundAmount.trim(),
        tokenId: this.fundTokenId.trim() || undefined,
      });
      this.message = t("dao.funded_msg", { tx });
      this.showFundModal = false;
      this.fundAmount = "";
      this.fundTokenId = "";
      await this.loadTreasury(this.fundDaoName);
    } catch (e: unknown) {
      this.error = formatInvokeError(e);
    } finally {
      this.loading = false;
    }
  }

  private async runExportRole() {
    if (!this.exportDaoName) return;
    this.loading = true;
    this.error = "";
    try {
      this.exportedToml = await api.daoExportRole(this.exportDaoName, this.exportRole);
    } catch (e: unknown) {
      this.exportedToml = "";
      this.error = formatInvokeError(e);
    } finally {
      this.loading = false;
    }
  }

  private async vote(bulla: string, yes: boolean) {
    this.votingProposal = bulla;
    this.error = "";
    this.message = "";
    try {
      const tx = await api.daoVote(bulla, yes);
      this.message = t("dao.vote_broadcast", { tx });
      if (this.selectedDao) {
        await this.loadProposals(this.selectedDao);
      }
    } catch (e: unknown) {
      this.error = formatInvokeError(e);
    } finally {
      this.votingProposal = null;
    }
  }

  private async execProposal(bulla: string) {
    this.executingProposal = bulla;
    this.error = "";
    this.message = "";
    try {
      const tx = await api.daoExecProposal(bulla);
      this.message = t("dao.proposal_executed", { tx });
      if (this.selectedDao) {
        await this.loadProposals(this.selectedDao);
      }
    } catch (e: unknown) {
      this.error = formatInvokeError(e);
    } finally {
      this.executingProposal = null;
    }
  }

  private async proposeTransfer() {
    if (!this.selectedDao || !this.proposeAmount.trim() || !this.proposeRecipient.trim()) {
      this.error = t("dao.err_propose_fields");
      return;
    }
    if (!isValidDrkAmount(this.proposeAmount)) {
      this.error = t("dao.err_propose_amount");
      return;
    }
    const duration = Number(this.proposeDuration);
    if (!Number.isInteger(duration) || duration <= 0) {
      this.error = t("dao.err_duration");
      return;
    }
    this.loading = true;
    this.error = "";
    this.message = "";
    try {
      const tx = await api.daoProposeTransfer({
        daoName: this.selectedDao,
        durationBlockwindows: duration,
        amount: this.proposeAmount.trim(),
        tokenId: this.proposeTokenId.trim() || undefined,
        recipientAddress: this.proposeRecipient.trim(),
      });
      this.message = t("dao.proposal_created", { tx });
      this.showProposeModal = false;
      this.proposeAmount = "";
      this.proposeRecipient = "";
      await this.loadProposals(this.selectedDao);
    } catch (e: unknown) {
      this.error = formatInvokeError(e);
    } finally {
      this.loading = false;
    }
  }

  render() {
    void this.localeTick;
    return html`
      <div class="header-row">
        <h2 class="screen-title">${t("nav.dao")}</h2>
        <div class="actions-row" style="margin-top: 0">
          <button
            class="small"
            ?disabled=${this.loading}
            @click=${() => {
              this.error = "";
              this.showCreateModal = true;
            }}
          >
            ${t("dao.create")}
          </button>
          <button
            class="secondary small"
            ?disabled=${this.loading}
            @click=${() => {
              this.error = "";
              this.showImportModal = true;
            }}
          >
            ${t("dao.import")}
          </button>
          <button class="secondary small" ?disabled=${this.loading} @click=${this.refreshDaos}>
            ${this.loading ? t("common.refreshing") : t("dao.refresh")}
          </button>
        </div>
      </div>

      ${this.message ? html`<div class="msg">${this.message}</div>` : null}
      ${this.error ? html`<div class="err">${this.error}</div>` : null}

      ${this.daos.length === 0
        ? html`
            <div class="card empty">
              <p>${t("dao.empty")}</p>
              <p style="font-size: var(--font-size-xs)">
                ${t("dao.empty_hint")}
              </p>
            </div>
          `
        : this.daos.map((dao) => this.renderDaoCard(dao))}

      ${this.showProposeModal ? this.renderProposeModal() : null}
      ${this.showCreateModal ? this.renderCreateModal() : null}
      ${this.showImportModal ? this.renderImportModal() : null}
      ${this.showFundModal ? this.renderFundModal() : null}
      ${this.showExportModal ? this.renderExportModal() : null}
    `;
  }

  private renderDaoCard(dao: DaoSummary) {
    const isSelected = this.selectedDao === dao.name;
    const treasury = this.treasuryByDao[dao.name];
    return html`
      <div class="card">
        <div class="dao-header">
          <span class="dao-name">${dao.name}</span>
          <span class="dao-bulla">${dao.bullaB58.slice(0, 16)}…</span>
        </div>

        <div class="stats-row">
          <div>
            ${t("dao.quorum")} <span class="stat-val">${dao.quorumDisplay}</span>
          </div>
          <div>
            ${t("dao.proposer_limit")}
            <span class="stat-val">${dao.proposerLimitDisplay}</span>
          </div>
          <div>
            ${t("approval.label")}
            <span class="stat-val">${dao.approvalRatioPercent.toFixed(1)}%</span>
          </div>
        </div>

        <div class="progress-bar">
          <div
            class="progress-fill"
            style="width: ${Math.min(100, Math.max(0, dao.approvalRatioPercent))}%"
          ></div>
        </div>

        <div class="roles-row">
          <span class="role-chip ${dao.canPropose ? "enabled" : ""}"
            >${dao.canPropose ? "✓" : "✕"} ${t("dao.role_propose")}</span
          >
          <span class="role-chip ${dao.canVote ? "enabled" : ""}"
            >${dao.canVote ? "✓" : "✕"} ${t("dao.role_vote")}</span
          >
          <span class="role-chip ${dao.canExec ? "enabled" : ""}"
            >${dao.canExec ? "✓" : "✕"} ${t("dao.role_execute")}</span
          >
        </div>

        <div class="actions-row">
          <button
            class="secondary small"
            @click=${() => this.loadProposals(dao.name)}
          >
            ${isSelected ? t("dao.refresh_proposals") : t("dao.view_proposals")}
          </button>
          <button
            class="small"
            ?disabled=${!dao.canPropose}
            title=${dao.canPropose
              ? t("dao.propose_tooltip")
              : t("dao.no_proposer_key")}
            @click=${() => {
              this.selectedDao = dao.name;
              this.showProposeModal = true;
            }}
          >
            ${t("dao.propose_transfer")}
          </button>
          <button
            class="secondary small"
            @click=${() => {
              this.fundDaoName = dao.name;
              this.fundAmount = "";
              this.fundTokenId = "";
              this.showFundModal = true;
            }}
          >
            ${t("dao.fund")}
          </button>
          <button
            class="secondary small"
            @click=${() => this.loadTreasury(dao.name)}
          >
            ${t("dao.treasury")}
          </button>
          <button
            class="secondary small"
            @click=${() => {
              this.exportDaoName = dao.name;
              this.exportRole = "voter";
              this.exportedToml = "";
              this.showExportModal = true;
            }}
          >
            ${t("dao.export_role")}
          </button>
        </div>

        ${treasury ? html`<div class="treasury-box">${treasury}</div>` : null}
        ${isSelected ? this.renderProposalsList(dao) : null}
      </div>
    `;
  }

  private renderProposalsList(dao: DaoSummary) {
    if (this.proposals.length === 0) {
      return html`
        <div style="margin-top: 12px; font-size: var(--font-size-sm); color: var(--color-text-muted)">
          ${t("dao.no_proposals", { name: dao.name })}
        </div>
      `;
    }

    return html`
      <div style="margin-top: 16px">
        <h4 style="margin: 0 0 8px; color: var(--color-text-header)">
          ${t("dao.proposals_heading", { name: dao.name, count: this.proposals.length })}
        </h4>
        ${this.proposals.map((p) => this.renderProposal(p, dao))}
      </div>
    `;
  }

  private renderProposal(p: DaoProposalSummary, dao: DaoSummary) {
    const statusClass = p.isExecuted ? "executed" : p.mintHeight > 0 ? "active" : "pending";
    const statusLabel = p.isExecuted
      ? t("common.executed")
      : p.mintHeight > 0
        ? t("common.active")
        : t("common.pending");
    const isVoting = this.votingProposal === p.proposalBullaB58;
    const isExecuting = this.executingProposal === p.proposalBullaB58;

    return html`
      <div class="proposal-card">
        <div style="display: flex; justify-content: space-between; align-items: baseline; margin-bottom: 4px">
          <span class="badge ${statusClass}">${statusLabel}</span>
          <span class="proposal-bulla">${p.proposalBullaB58.slice(0, 16)}…</span>
        </div>
        <div class="proposal-summary">
          ${p.summaryLine || t("dao.transfer_proposal")}
        </div>
        <div style="font-size: var(--font-size-xs); color: var(--color-text-muted); margin-bottom: 8px">
          ${t("dao.proposal_meta", {
            duration: p.durationBlockwindows,
            calls: p.authCallCount,
          })}
        </div>
        ${!p.isExecuted
          ? html`
              <div class="actions-row">
                <button
                  class="vote-yes small"
                  ?disabled=${isVoting || !dao.canVote}
                  title=${dao.canVote ? t("dao.vote_yes") : t("dao.no_voter_key")}
                  @click=${() => this.vote(p.proposalBullaB58, true)}
                >
                  ${isVoting ? t("dao.voting") : t("dao.vote_yes")}
                </button>
                <button
                  class="vote-no small"
                  ?disabled=${isVoting || !dao.canVote}
                  title=${dao.canVote ? t("dao.vote_no") : t("dao.no_voter_key")}
                  @click=${() => this.vote(p.proposalBullaB58, false)}
                >
                  ${isVoting ? t("dao.voting") : t("dao.vote_no")}
                </button>
                <button
                  class="secondary small"
                  ?disabled=${isExecuting || !dao.canExec}
                  title=${dao.canExec ? t("dao.exec_tooltip") : t("dao.no_executor_key")}
                  @click=${() => this.execProposal(p.proposalBullaB58)}
                >
                  ${isExecuting ? t("dao.executing") : t("dao.role_execute")}
                </button>
              </div>
            `
          : null}
      </div>
    `;
  }

  private renderCreateModal() {
    return html`
      <div class="modal-overlay" @click=${(e: Event) => {
        if (e.target === e.currentTarget) this.showCreateModal = false;
      }}>
        <div class="modal">
          <h3>${t("dao.create")}</h3>
          <label>${t("dao.modal_name")}</label>
          <input
            placeholder="e.g. my-dao"
            .value=${this.createName}
            @input=${(e: Event) => (this.createName = (e.target as HTMLInputElement).value)}
          />
          <label>${t("dao.modal_gov_token")}</label>
          <input
            placeholder="DRK"
            .value=${this.createGovTokenId}
            @input=${(e: Event) => (this.createGovTokenId = (e.target as HTMLInputElement).value)}
          />
          <label>${t("dao.modal_proposer_min")}</label>
          <input
            placeholder="1"
            .value=${this.createProposerLimit}
            @input=${(e: Event) => (this.createProposerLimit = (e.target as HTMLInputElement).value)}
          />
          <label>${t("dao.modal_quorum")}</label>
          <input
            placeholder="10"
            .value=${this.createQuorum}
            @input=${(e: Event) => (this.createQuorum = (e.target as HTMLInputElement).value)}
          />
          <label>${t("dao.modal_early_exec")}</label>
          <input
            placeholder=${t("dao.modal_optional")}
            .value=${this.createEarlyExecQuorum}
            @input=${(e: Event) => (this.createEarlyExecQuorum = (e.target as HTMLInputElement).value)}
          />
          <label>${t("dao.modal_ratio")}</label>
          <input
            type="number"
            step="0.05"
            min="0.01"
            max="1"
            .value=${this.createApprovalRatio}
            @input=${(e: Event) => (this.createApprovalRatio = (e.target as HTMLInputElement).value)}
          />
          <div class="modal-actions">
            <button class="secondary" @click=${() => (this.showCreateModal = false)}>
              ${t("common.cancel")}
            </button>
            <button ?disabled=${this.loading} @click=${this.createDao}>
              ${this.loading ? t("common.creating") : t("dao.create_and_mint")}
            </button>
          </div>
        </div>
      </div>
    `;
  }

  private renderImportModal() {
    return html`
      <div class="modal-overlay" @click=${(e: Event) => {
        if (e.target === e.currentTarget) this.showImportModal = false;
      }}>
        <div class="modal">
          <h3>${t("dao.import")}</h3>
          <label>${t("dao.local_name")}</label>
          <input
            placeholder="e.g. community-dao"
            .value=${this.importName}
            @input=${(e: Event) => (this.importName = (e.target as HTMLInputElement).value)}
          />
          <label>${t("dao.role_toml")}</label>
          <textarea
            rows="6"
            placeholder=${t("dao.paste_toml")}
            .value=${this.importToml}
            @input=${(e: Event) => (this.importToml = (e.target as HTMLTextAreaElement).value)}
          ></textarea>
          <div class="modal-actions">
            <button class="secondary" @click=${() => (this.showImportModal = false)}>
              ${t("common.cancel")}
            </button>
            <button ?disabled=${this.loading} @click=${this.importDao}>
              ${this.loading ? t("dao.importing") : t("dao.import_action")}
            </button>
          </div>
        </div>
      </div>
    `;
  }

  private renderFundModal() {
    return html`
      <div class="modal-overlay" @click=${(e: Event) => {
        if (e.target === e.currentTarget) this.showFundModal = false;
      }}>
        <div class="modal">
          <h3>${t("dao.fund_title", { name: this.fundDaoName })}</h3>
          <label>${t("wallet.amount")}</label>
          <input
            placeholder="e.g. 5.0"
            .value=${this.fundAmount}
            @input=${(e: Event) => (this.fundAmount = (e.target as HTMLInputElement).value)}
          />
          <label>${t("dao.token_id_optional")}</label>
          <input
            placeholder=${t("dao.token_id_placeholder")}
            .value=${this.fundTokenId}
            @input=${(e: Event) => (this.fundTokenId = (e.target as HTMLInputElement).value)}
          />
          <div class="modal-actions">
            <button class="secondary" @click=${() => (this.showFundModal = false)}>
              ${t("common.cancel")}
            </button>
            <button ?disabled=${this.loading} @click=${this.fundDao}>
              ${this.loading ? t("dao.funding") : t("dao.fund_treasury")}
            </button>
          </div>
        </div>
      </div>
    `;
  }

  private renderExportModal() {
    return html`
      <div class="modal-overlay" @click=${(e: Event) => {
        if (e.target === e.currentTarget) this.showExportModal = false;
      }}>
        <div class="modal">
          <h3>${t("dao.export_title", { name: this.exportDaoName })}</h3>
          <label>${t("dao.role_label")}</label>
          <select
            .value=${this.exportRole}
            @change=${(e: Event) => (this.exportRole = (e.target as HTMLSelectElement).value)}
          >
            <option value="voter">${t("dao.role_voter")}</option>
            <option value="proposer">${t("dao.role_proposer")}</option>
            <option value="executor">${t("dao.role_executor")}</option>
            <option value="all">${t("dao.role_all")}</option>
          </select>
          ${this.exportedToml
            ? html`
                <label>${t("dao.exported_toml_label")}</label>
                <textarea rows="6" readonly .value=${this.exportedToml}></textarea>
              `
            : null}
          <div class="modal-actions">
            <button
              class="secondary"
              @click=${() => {
                this.showExportModal = false;
                this.exportedToml = "";
              }}
            >
              ${t("common.close")}
            </button>
            ${this.exportedToml
              ? html`
                  <button
                    class="secondary"
                    @click=${() => {
                      void navigator.clipboard.writeText(this.exportedToml);
                      this.message = t("dao.toml_copied");
                      if (this.tomlClipClearTimer) clearTimeout(this.tomlClipClearTimer);
                      this.tomlClipClearTimer = window.setTimeout(() => {
                        void api.clearOsClipboard().catch(() => undefined);
                        void navigator.clipboard?.writeText("").catch(() => undefined);
                      }, 60_000);
                    }}
                  >
                    ${t("dao.copy_toml")}
                  </button>
                `
              : null}
            <button ?disabled=${this.loading} @click=${this.runExportRole}>
              ${this.loading ? t("dao.exporting") : t("dao.export_action")}
            </button>
          </div>
        </div>
      </div>
    `;
  }

  private renderProposeModal() {
    return html`
      <div class="modal-overlay" @click=${(e: Event) => {
        if (e.target === e.currentTarget) this.showProposeModal = false;
      }}>
        <div class="modal">
          <h3>${t("dao.propose_title", { name: this.selectedDao })}</h3>

          <label>${t("wallet.amount_hint")}</label>
          <input
            placeholder="e.g. 10.5"
            .value=${this.proposeAmount}
            @input=${(e: Event) => (this.proposeAmount = (e.target as HTMLInputElement).value)}
          />

          <label>${t("dao.propose_recipient")}</label>
          <input
            placeholder="drk1..."
            .value=${this.proposeRecipient}
            @input=${(e: Event) => (this.proposeRecipient = (e.target as HTMLInputElement).value)}
          />

          <label>${t("mine.duration")}</label>
          <input
            type="number"
            .value=${this.proposeDuration}
            @input=${(e: Event) => (this.proposeDuration = (e.target as HTMLInputElement).value)}
          />

          <label>${t("dao.token_id_optional")}</label>
          <input
            placeholder=${t("dao.propose_token_placeholder")}
            .value=${this.proposeTokenId}
            @input=${(e: Event) => (this.proposeTokenId = (e.target as HTMLInputElement).value)}
          />

          <div class="modal-actions">
            <button class="secondary" @click=${() => (this.showProposeModal = false)}>
              ${t("common.cancel")}
            </button>
            <button ?disabled=${this.loading} @click=${this.proposeTransfer}>
              ${this.loading ? t("dao.proposing") : t("dao.submit_proposal")}
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
