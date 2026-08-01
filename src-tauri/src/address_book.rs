//! Local address book (desktop-only; not part of UniFFI).

use crate::paths::address_book_path;
use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};
use std::fs;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AddressBookEntry {
    pub id: String,
    pub label: String,
    pub address: String,
    #[serde(default)]
    pub notes: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct AddressBookFile {
    entries: Vec<AddressBookEntry>,
}

fn load() -> Result<AddressBookFile> {
    let path = address_book_path();
    if !path.exists() {
        return Ok(AddressBookFile::default());
    }
    let s = fs::read_to_string(&path).context("read address book")?;
    Ok(serde_json::from_str(&s).unwrap_or_default())
}

fn save(book: &AddressBookFile) -> Result<()> {
    if let Some(parent) = address_book_path().parent() {
        fs::create_dir_all(parent)?;
    }
    let s = serde_json::to_string_pretty(book)?;
    fs::write(address_book_path(), s).context("write address book")?;
    Ok(())
}

pub fn list_entries() -> Result<Vec<AddressBookEntry>> {
    Ok(load()?.entries)
}

pub fn upsert_entry(entry: AddressBookEntry) -> Result<Vec<AddressBookEntry>> {
    let mut book = load()?;
    if let Some(i) = book.entries.iter().position(|e| e.id == entry.id) {
        book.entries[i] = entry;
    } else {
        book.entries.push(entry);
    }
    save(&book)?;
    Ok(book.entries)
}

pub fn remove_entry(id: &str) -> Result<Vec<AddressBookEntry>> {
    let mut book = load()?;
    book.entries.retain(|e| e.id != id);
    save(&book)?;
    Ok(book.entries)
}
