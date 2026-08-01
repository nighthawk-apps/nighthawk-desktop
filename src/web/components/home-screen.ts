/*
 * Copyright (c) 2026 Nighthawk Apps
 * All rights reserved.
 */

import { LitElement, html, css } from 'lit';
import { customElement, state } from 'lit/decorators.js';
import { invoke } from '@tauri-apps/api/core';

@customElement('home-screen')
export class HomeScreen extends LitElement {
  @state() private balance = 0;
  @state() private url = 'http://localhost:9092';
  @state() private isSyncing = false;
  @state() private syncProgress = '';

  static styles = css`
    .container {
      padding: 24px;
      color: var(--color-text-body);
      max-width: 800px;
      margin: 0 auto;
    }
    .balance-card {
      background-color: var(--color-ink-panel);
      padding: 32px;
      border-radius: var(--border-radius-xl);
      text-align: center;
      margin-bottom: 24px;
      border: 1px solid var(--color-steel-border);
      box-shadow: 0 4px 20px rgba(0,0,0,0.2);
    }
    .balance-title {
      font-size: var(--font-size-sm);
      color: var(--color-text-muted);
      margin-bottom: 12px;
      text-transform: uppercase;
      letter-spacing: 0.05em;
    }
    .balance-amount {
      font-size: 48px;
      font-weight: 700;
      color: var(--color-text-header);
    }
    .currency {
      color: var(--color-accent);
      font-size: var(--font-size-xl);
      margin-left: 8px;
    }
    .connection {
      display: flex;
      flex-direction: column;
      gap: 16px;
      margin-bottom: 24px;
      background: var(--color-secondary-fill);
      padding: 20px;
      border-radius: var(--border-radius-lg);
      border: 1px solid var(--color-steel-border-muted);
    }
    .connection-header {
      color: var(--color-text-header);
      font-weight: 600;
      font-size: var(--font-size-md);
    }
    .input-row {
      display: flex;
      gap: 12px;
    }
    input {
      flex: 1;
      padding: 12px 16px;
      border: 1px solid var(--color-steel-border);
      background: var(--color-elevated);
      color: var(--color-text-header);
      border-radius: var(--border-radius-md);
      font-size: var(--font-size-md);
      transition: border-color var(--transition-fast);
    }
    input:focus {
      outline: none;
      border-color: var(--color-accent);
    }
    button {
      padding: 12px 24px;
      background-color: var(--color-accent);
      color: var(--color-on-accent);
      border: none;
      border-radius: var(--border-radius-md);
      font-size: var(--font-size-md);
      font-weight: 600;
      cursor: pointer;
      transition: background-color var(--transition-fast);
    }
    button:hover:not(:disabled) {
      background-color: var(--color-accent-muted);
    }
    button:disabled {
      background-color: var(--color-steel-border);
      color: var(--color-text-muted);
      cursor: not-allowed;
    }
    .sync-status {
      margin-top: 12px;
      font-size: var(--font-size-sm);
      color: var(--color-accent-muted);
    }
  `;

  connectedCallback() {
    super.connectedCallback();
    this.refreshBalance();
    
    // Periodically poll balance
    setInterval(() => {
      if (!this.isSyncing) {
        this.refreshBalance();
      }
    }, 10000);
  }

  async refreshBalance() {
    try {
      const res: any = await invoke('get_balance');
      this.balance = res.total;
    } catch (e) {
      console.error('Failed to get balance', e);
    }
  }

  async syncWallet() {
    if (this.isSyncing) return;
    
    this.isSyncing = true;
    this.syncProgress = 'Syncing...';
    
    try {
      // For now we don't block the UI strictly, just show syncing state
      const result: any = await invoke('sync_wallet', { serverUrl: this.url });
      console.log('Sync finished', result);
      this.syncProgress = `Synced up to block ${result.tip_height} (${result.blocks_scanned} scanned)`;
      await this.refreshBalance();
    } catch (e: any) {
      console.error('Sync failed', e);
      this.syncProgress = 'Sync failed: ' + e.toString();
    } finally {
      this.isSyncing = false;
    }
  }

  render() {
    return html`
      <div class="container">
        
        <div class="balance-card">
          <div class="balance-title">Available Balance</div>
          <div class="balance-amount">${this.balance}<span class="currency">DRK</span></div>
        </div>

        <div class="connection">
          <div class="connection-header">Network Node</div>
          <div class="input-row">
            <input 
              type="text" 
              .value="${this.url}" 
              @input="${(e: any) => this.url = e.target.value}"
              placeholder="e.g. http://localhost:9092"
              ?disabled="${this.isSyncing}"
            />
            <button @click="${this.syncWallet}" ?disabled="${this.isSyncing}">
              ${this.isSyncing ? 'Syncing...' : 'Sync Wallet'}
            </button>
          </div>
          ${this.syncProgress ? html`<div class="sync-status">${this.syncProgress}</div>` : ''}
        </div>
        
      </div>
    `;
  }
}
