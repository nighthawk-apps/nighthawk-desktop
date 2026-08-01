/* This file is part of Nighthawk Apps (https://nighthawkapps.com)
 *
 * Copyright (C) 2026 Nighthawk Apps
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU Affero General Public License as
 * published by the Free Software Foundation, either version 3 of the
 * License, or (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU Affero General Public License for more details.
 *
 * You should have received a copy of the GNU Affero General Public License
 * along with this program.  If not, see <https://www.gnu.org/licenses/>.
 */

use std::sync::Arc;
use tauri::{AppHandle, Manager, State};
use tauri_plugin_shell::process::CommandChild;
use tauri_plugin_shell::{process::CommandEvent, ShellExt};
use tokio::sync::Mutex;

pub struct DarkircState {
    pub child_process: Arc<Mutex<Option<CommandChild>>>,
    pub is_running: Arc<Mutex<bool>>,
}

#[tauri::command]
pub async fn start_darkirc_daemon(
    app: AppHandle,
    state: State<'_, DarkircState>,
    config_path: String,
) -> Result<(), String> {
    let mut is_running = state.is_running.lock().await;
    if *is_running {
        return Ok(());
    }

    // M5: Sanitize config_path — reject shell metacharacters, null bytes,
    // and path traversal. Only accept existing .toml files.
    let config_path = config_path.trim().to_string();
    if config_path.is_empty() {
        return Err("config_path cannot be empty".into());
    }
    if config_path.contains('\0') {
        return Err("config_path contains null byte".into());
    }
    let canon = std::path::Path::new(&config_path)
        .canonicalize()
        .map_err(|e| format!("config_path not found or inaccessible: {e}"))?;
    if !canon.is_file() {
        return Err("config_path does not point to a file".into());
    }
    if canon.extension().and_then(|e| e.to_str()) != Some("toml") {
        return Err("config_path must be a .toml file".into());
    }
    let config_path = canon.to_string_lossy().to_string();

    println!(
        "Starting darkirc sidecar daemon with config: {}",
        config_path
    );

    let (mut rx, child) = app
        .shell()
        .sidecar("darkirc")
        .map_err(|e| format!("Failed to create sidecar command: {}", e))?
        .args(["--config", &config_path])
        .spawn()
        .map_err(|e| format!("Failed to spawn darkirc: {}", e))?;

    let is_running_clone = state.is_running.clone();

    // Spawn a task to handle process stdout/stderr and termination
    tauri::async_runtime::spawn(async move {
        while let Some(event) = rx.recv().await {
            match event {
                CommandEvent::Stdout(line) => {
                    println!("[DarkIRC] {}", String::from_utf8_lossy(&line))
                }
                CommandEvent::Stderr(line) => {
                    eprintln!("[DarkIRC ERR] {}", String::from_utf8_lossy(&line))
                }
                CommandEvent::Error(err) => eprintln!("[DarkIRC FATAL] {}", err),
                CommandEvent::Terminated(payload) => {
                    println!("[DarkIRC] Process terminated with code: {:?}", payload.code);
                    *is_running_clone.lock().await = false;
                    break;
                }
                _ => {}
            }
        }
    });

    let mut lock = state.child_process.lock().await;
    *lock = Some(child);
    *is_running = true;

    Ok(())
}

#[tauri::command]
pub async fn stop_darkirc_daemon(state: State<'_, DarkircState>) -> Result<(), String> {
    let mut lock = state.child_process.lock().await;
    if let Some(child) = lock.take() {
        println!("Stopping darkirc daemon...");
        child
            .kill()
            .map_err(|e| format!("Failed to kill daemon: {}", e))?;
    }

    let mut is_running = state.is_running.lock().await;
    *is_running = false;
    Ok(())
}
