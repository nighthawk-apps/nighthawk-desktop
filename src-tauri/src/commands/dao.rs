use super::*;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DaoSummaryDto {
    pub name: String,
    pub bulla_b58: String,
    pub gov_token_id: String,
    pub quorum_display: String,
    pub proposer_limit_display: String,
    pub approval_ratio_percent: f64,
    pub mint_height: i64,
    pub can_propose: bool,
    pub can_vote: bool,
    pub can_exec: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DaoProposalSummaryDto {
    pub proposal_bulla_b58: String,
    pub dao_name: String,
    pub dao_bulla_b58: String,
    pub auth_call_count: u32,
    pub duration_blockwindows: u64,
    pub creation_blockwindow: u64,
    pub mint_height: i64,
    pub exec_height: i64,
    pub is_executed: bool,
    pub summary_line: String,
}

#[tauri::command]
pub async fn list_daos(state: State<'_, AppState>) -> Result<Vec<DaoSummaryDto>, String> {
    with_wallet_blocking(&state, |w| {
        let list = w.list_daos().map_err(ffi_err)?;
        Ok(list
            .into_iter()
            .map(|d| DaoSummaryDto {
                name: d.name,
                bulla_b58: d.bulla_b58,
                gov_token_id: d.gov_token_id,
                quorum_display: d.quorum_display,
                proposer_limit_display: d.proposer_limit_display,
                approval_ratio_percent: d.approval_ratio_percent,
                mint_height: d.mint_height,
                can_propose: d.can_propose,
                can_vote: d.can_vote,
                can_exec: d.can_exec,
            })
            .collect())
    })
    .await
}

#[tauri::command]
pub async fn list_proposals(
    state: State<'_, AppState>,
    dao_name: Option<String>,
) -> Result<Vec<DaoProposalSummaryDto>, String> {
    with_wallet_blocking(&state, |w| {
        let list = w.list_proposals(dao_name).map_err(ffi_err)?;
        Ok(list
            .into_iter()
            .map(|p| DaoProposalSummaryDto {
                proposal_bulla_b58: p.proposal_bulla_b58,
                dao_name: p.dao_name,
                dao_bulla_b58: p.dao_bulla_b58,
                auth_call_count: p.auth_call_count,
                duration_blockwindows: p.duration_blockwindows,
                creation_blockwindow: p.creation_blockwindow,
                mint_height: p.mint_height,
                exec_height: p.exec_height,
                is_executed: p.is_executed,
                summary_line: p.summary_line,
            })
            .collect())
    })
    .await
}

#[tauri::command]
pub async fn dao_create(
    state: State<'_, AppState>,
    name: String,
    proposer_limit: String,
    quorum: String,
    early_exec_quorum: String,
    approval_ratio: f64,
    gov_token_id: String,
) -> Result<String, String> {
    with_wallet_blocking(&state, move |w| {
        reject_until_spend_ready(&w)?;
        w.dao_create(
            name,
            proposer_limit,
            quorum,
            early_exec_quorum,
            approval_ratio,
            gov_token_id,
        )
        .map_err(ffi_err)
    })
    .await
}

#[tauri::command]
pub async fn dao_import(
    state: State<'_, AppState>,
    name: String,
    toml: String,
) -> Result<String, String> {
    with_wallet_blocking(&state, move |w| w.dao_import(name, toml).map_err(ffi_err)).await
}

#[tauri::command]
pub async fn dao_export_role(
    state: State<'_, AppState>,
    dao_name: String,
    role: String,
) -> Result<String, String> {
    with_wallet_blocking(&state, move |w| {
        w.dao_export_role(dao_name, role).map_err(ffi_err)
    })
    .await
}

#[tauri::command]
pub async fn dao_fund(
    state: State<'_, AppState>,
    dao_name: String,
    amount: String,
    token_id: Option<String>,
) -> Result<String, String> {
    with_wallet_blocking(&state, move |w| {
        reject_until_spend_ready(&w)?;
        w.dao_fund(dao_name, amount, token_id).map_err(ffi_err)
    })
    .await
}

#[tauri::command]
pub async fn dao_treasury(state: State<'_, AppState>, dao_name: String) -> Result<String, String> {
    with_wallet_blocking(&state, move |w| w.dao_treasury(dao_name).map_err(ffi_err)).await
}

#[tauri::command]
pub async fn dao_propose_transfer(
    state: State<'_, AppState>,
    dao_name: String,
    duration_blockwindows: u64,
    amount: String,
    token_id: Option<String>,
    recipient_address: String,
) -> Result<String, String> {
    with_wallet_blocking(&state, move |w| {
        reject_until_spend_ready(&w)?;
        w.dao_propose_transfer(
            dao_name,
            duration_blockwindows,
            amount,
            token_id,
            recipient_address,
        )
        .map_err(ffi_err)
    })
    .await
}

#[tauri::command]
pub async fn dao_vote(
    state: State<'_, AppState>,
    proposal_bulla_b58: String,
    vote_yes: bool,
) -> Result<String, String> {
    with_wallet_blocking(&state, move |w| {
        reject_until_spend_ready(&w)?;
        w.dao_vote(proposal_bulla_b58, vote_yes).map_err(ffi_err)
    })
    .await
}

#[tauri::command]
pub async fn dao_exec_proposal(
    state: State<'_, AppState>,
    proposal_bulla_b58: String,
) -> Result<String, String> {
    with_wallet_blocking(&state, move |w| {
        reject_until_spend_ready(&w)?;
        w.dao_exec(proposal_bulla_b58).map_err(ffi_err)
    })
    .await
}

#[tauri::command]
pub async fn handle_reorg_recovery(
    state: State<'_, AppState>,
    rewind_to_height: u32,
) -> Result<ReorgDto, String> {
    with_wallet_blocking(&state, move |w| {
        let e = w.handle_reorg_recovery(rewind_to_height).map_err(ffi_err)?;
        Ok(ReorgDto {
            detected_at_height: e.detected_at_height,
            rewound_to: e.rewound_to,
            blocks_invalidated: e.blocks_invalidated,
            txs_affected: e.txs_affected,
            summary_message: e.summary_message,
        })
    })
    .await
}
