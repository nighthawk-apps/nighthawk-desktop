import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

export type Network = "testnet" | "mainnet";
export type FeeTier = "economy" | "normal" | "priority";

/** Prefer omitting undefined so optional Tauri args deserialize as None. */
function invokeCmd<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  if (!args) return invoke<T>(cmd);
  const cleaned: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(args)) {
    if (v !== undefined) cleaned[k] = v;
  }
  return invoke<T>(cmd, cleaned);
}

/** Tauri rejects with string | Error | { message } — never show "[object Object]". */
export function formatInvokeError(e: unknown): string {
  if (typeof e === "string") return e;
  if (e instanceof Error) return e.message || String(e);
  if (e && typeof e === "object") {
    const rec = e as Record<string, unknown>;
    if (typeof rec.message === "string") return rec.message;
    if (typeof rec.error === "string") return rec.error;
    try {
      return JSON.stringify(e);
    } catch {
      /* fall through */
    }
  }
  return String(e);
}

export interface Prefs {
  network: Network;
  lightwalletUrl: string;
  darkfidRpcUrl: string | null;
  stratumUrl: string;
  useTor: boolean;
  torSocksPort: number;
  mineThreads: number;
  chatNick: string;
  birthdayHeight: number;
  lightwalletTlsPinSha256: string | null;
  feeTier: FeeTier;
  activeWalletId: string;
  /** UnifOMR-only sync (no trial-decrypt fallback). Default false. */
  strictOmrOnly: boolean;
}

/** Normalize fee tier from prefs (camelCase feeTier). */
export function prefsFeeTier(p: Prefs & { feeTier?: string }): FeeTier {
  const t = p.feeTier ?? "normal";
  if (t === "economy" || t === "priority") return t;
  return "normal";
}

export interface AppStatus {
  walletOpen: boolean;
  network: Network;
  hasPin: boolean;
}

export interface SyncSnapshot {
  scannedBlocks: number;
  chainTip: number;
}

export interface LightSyncState {
  status: string;
  syncType: string;
  statusMessage: string;
  syncTypeMessage: string;
  scannedHeight: number;
  chainTip: number;
  omrAvailable: boolean;
  syncMethod: string;
  fallbackReason: string;
  fallbackUserMessage: string;
}

export interface TxRecord {
  txHash: string;
  height: number;
  timestamp: number;
  status: string;
  summary: string;
}

export interface TokenBalance {
  tokenId: string;
  displayLabel: string | null;
  balanceAtomic: number;
}

export interface MineStatus {
  running: boolean;
  threads: number;
  stratumUrl: string;
  address: string;
  hashrateHs: number | null;
  lastLog: string;
}

export interface ChatMessage {
  eventId: string;
  channel: string;
  nick: string;
  message: string;
  timestamp: number;
}

export interface ReorgEvent {
  detectedAtHeight: number;
  rewoundTo: number;
  blocksInvalidated: number;
  txsAffected: number;
  summaryMessage: string;
}

export interface DaoSummary {
  name: string;
  bullaB58: string;
  govTokenId: string;
  quorumDisplay: string;
  proposerLimitDisplay: string;
  approvalRatioPercent: number;
  mintHeight: number;
  canPropose: boolean;
  canVote: boolean;
  canExec: boolean;
}

export interface DaoProposalSummary {
  proposalBullaB58: string;
  daoName: string;
  daoBullaB58: string;
  authCallCount: number;
  durationBlockwindows: number;
  creationBlockwindow: number;
  mintHeight: number;
  execHeight: number;
  isExecuted: boolean;
  summaryLine: string;
}

export interface DmKeypair {
  secretB58: string;
  publicB58: string;
}

export interface AddressBookEntry {
  id: string;
  label: string;
  address: string;
  notes: string;
}

export interface WalletProfile {
  id: string;
  label: string;
  createdAt: number;
}

export interface WalletProfiles {
  activeId: string;
  wallets: WalletProfile[];
}

export const api = {
  appStatus: () => invokeCmd<AppStatus>("app_status"),
  getPrefs: () => invokeCmd<Prefs>("get_prefs"),
  setPrefs: (prefs: Prefs) => invokeCmd<void>("set_prefs", { prefs }),

  walletExists: () => invokeCmd<boolean>("wallet_exists"),
  generateMnemonic: () => invokeCmd<string[]>("generate_mnemonic"),
  createWallet: (args: {
    mnemonic: string[];
    network: Network;
    birthdayHeight: number;
    lightwalletUrl?: string;
  }) =>
    invokeCmd<void>("create_wallet", {
      mnemonic: args.mnemonic,
      network: args.network,
      birthdayHeight: args.birthdayHeight,
      lightwalletUrl: args.lightwalletUrl ?? null,
    }),
  restoreWallet: (args: {
    mnemonic: string[];
    network: Network;
    birthdayHeight: number;
    lightwalletUrl?: string;
  }) =>
    invokeCmd<void>("restore_wallet", {
      mnemonic: args.mnemonic,
      network: args.network,
      birthdayHeight: args.birthdayHeight,
      lightwalletUrl: args.lightwalletUrl ?? null,
    }),
  /** Open existing vault (no PIN). */
  openWallet: () => invokeCmd<void>("open_wallet"),

  walletBalance: () => invokeCmd<number>("wallet_balance"),
  walletAddress: () => invokeCmd<string>("wallet_address"),
  walletAddresses: () => invokeCmd<string[]>("wallet_addresses"),
  walletRefresh: () => invokeCmd<SyncSnapshot>("wallet_refresh"),
  walletSyncSnapshot: () => invokeCmd<SyncSnapshot>("wallet_sync_snapshot"),
  walletLightSync: () => invokeCmd<LightSyncState>("wallet_light_sync"),
  walletListTxs: () => invokeCmd<TxRecord[]>("wallet_list_txs"),
  listTokenBalances: () => invokeCmd<TokenBalance[]>("list_token_balances"),
  transactionPaymentMemo: (txHash: string) =>
    invokeCmd<string | null>("transaction_payment_memo", { txHash }),
  transactionRecipient: (txHash: string) =>
    invokeCmd<string | null>("transaction_recipient", { txHash }),
  estimateFee: (args: {
    recipient: string;
    amount: string;
    memo?: string;
    tokenId?: string;
  }) => invokeCmd<number>("estimate_fee", { ...args }),
  sendDrk: (args: {
    recipient: string;
    amount: string;
    memo?: string;
    tokenId?: string;
  }) => invokeCmd<string>("send_drk", { ...args }),
  generateAddress: () => invokeCmd<string>("generate_address"),

  listDaos: () => invokeCmd<DaoSummary[]>("list_daos"),
  listProposals: (daoName?: string) =>
    invokeCmd<DaoProposalSummary[]>("list_proposals", {
      daoName: daoName ?? null,
    }),
  getProposal: (proposalBullaB58: string) =>
    invokeCmd("get_proposal", { proposalBullaB58 }),
  daoProposeTransfer: (args: {
    daoName: string;
    durationBlockwindows: number;
    amount: string;
    tokenId?: string;
    recipientAddress: string;
  }) => invokeCmd<string>("dao_propose_transfer", { ...args }),
  daoVote: (proposalBullaB58: string, voteYes: boolean) =>
    invokeCmd<string>("dao_vote", { proposalBullaB58, voteYes }),
  handleReorgRecovery: (rewindToHeight: number) =>
    invokeCmd<ReorgEvent>("handle_reorg_recovery", { rewindToHeight }),
  onReorg: (cb: (e: ReorgEvent) => void): Promise<UnlistenFn> =>
    listen<ReorgEvent>("wallet://reorg", (e) => cb(e.payload)),

  artiStart: () => invokeCmd<boolean>("arti_start"),
  artiStop: () => invokeCmd<void>("arti_stop"),
  artiStatus: () => invokeCmd<boolean>("arti_status"),

  dmGenerateKeypair: () => invokeCmd<DmKeypair>("dm_generate_keypair"),
  dmLoadKeypair: () => invokeCmd<DmKeypair | null>("dm_load_keypair"),
  dmEncrypt: (args: {
    mySecretB58: string;
    theirPublicB58: string;
    plaintext: string;
  }) => invokeCmd<string>("dm_encrypt", { ...args }),
  dmDecrypt: (args: {
    mySecretB58: string;
    theirPublicB58: string;
    ciphertextB58: string;
  }) => invokeCmd<string>("dm_decrypt", { ...args }),

  addressBookList: () => invokeCmd<AddressBookEntry[]>("address_book_list"),
  addressBookUpsert: (entry: AddressBookEntry) =>
    invokeCmd<AddressBookEntry[]>("address_book_upsert", { entry }),
  addressBookRemove: (id: string) =>
    invokeCmd<AddressBookEntry[]>("address_book_remove", { id }),

  walletsList: () => invokeCmd<WalletProfiles>("wallets_list"),
  walletsCreate: (label: string) =>
    invokeCmd<WalletProfile>("wallets_create", { label }),
  walletsSwitch: (walletId: string) =>
    invokeCmd<void>("wallets_switch", { walletId }),
  walletsRename: (walletId: string, label: string) =>
    invokeCmd<WalletProfile[]>("wallets_rename", { walletId, label }),
  walletsRemove: (walletId: string) =>
    invokeCmd<WalletProfile[]>("wallets_remove", { walletId }),

  chatStart: () => invokeCmd<void>("chat_start"),
  chatStop: () => invokeCmd<void>("chat_stop"),
  chatStatus: () => invokeCmd<string>("chat_status"),
  chatSend: (channel: string, message: string) =>
    invokeCmd<void>("chat_send", { channel, message }),
  getChatNick: () => invokeCmd<string>("get_chat_nick"),
  setChatNick: (nickname: string) =>
    invokeCmd<void>("set_chat_nick", { nickname }),
  onChatMessage: (cb: (m: ChatMessage) => void): Promise<UnlistenFn> =>
    listen<ChatMessage>("chat://message", (e) => cb(e.payload)),

  mineStatus: () => invokeCmd<MineStatus>("mine_status"),
  mineStart: (threads?: number) =>
    invokeCmd<void>(
      "mine_start",
      threads === undefined ? {} : { threads },
    ),
  mineStop: () => invokeCmd<void>("mine_stop"),

  setNetwork: (network: Network) => invokeCmd<void>("set_network", { network }),
  setLwdUrl: (url: string) => invokeCmd<void>("set_lwd_url", { url }),
  backupMnemonic: () => invokeCmd<string[]>("backup_mnemonic"),
  wipeWallet: () => invokeCmd<void>("wipe_wallet"),
};
