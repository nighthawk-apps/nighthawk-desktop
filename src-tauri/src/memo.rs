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

//! OMR metadata encryption for the LWD off-chain channel.
//!
//! Encrypts scheme + clue seed + user memo with the recipient's public key
//! via `AeadEncryptedNote`. LWD stores opaquely and cannot decrypt.

use darkfi_sdk::crypto::{note::AeadEncryptedNote, PublicKey, SecretKey};
use darkfi_serial::{serialize, Decodable, Encodable};

/// Magic byte identifying OMR-aware metadata.
pub const OMR_MEMO_MAGIC: u8 = 0x4F;

/// UnifOMR scheme identifier.
pub const SCHEME_UNIFOMR: u8 = 0x05;

const FLAG_HAS_USER_MEMO: u8 = 0x01;
const FLAG_UNIFOMR_VALIDATED: u8 = 0x02;

/// Build OMR metadata plaintext (same wire format as mobile FFI `build_omr_memo`).
pub fn build_omr_memo(
    sender_secret: &[u8; 32],
    recipient_pubkey: &[u8; 32],
    user_memo: Option<&str>,
    scheme: Option<u8>,
) -> Result<Vec<u8>, String> {
    let scheme = scheme.unwrap_or(SCHEME_UNIFOMR);

    let mut hasher = blake3::Hasher::new_keyed(sender_secret);
    hasher.update(recipient_pubkey);
    hasher.update(b"DarkFi-OMR-TxClue-v1");
    hasher.update(&[scheme]);
    let clue_seed: [u8; 32] = hasher.finalize().into();

    let memo_bytes = user_memo
        .filter(|s| !s.trim().is_empty())
        .map(|s| s.as_bytes());

    if let Some(bytes) = &memo_bytes {
        if bytes.len() > 255 {
            return Err("User memo exceeds 255 bytes".into());
        }
    }

    let mut flags = FLAG_UNIFOMR_VALIDATED;
    if memo_bytes.is_some() {
        flags |= FLAG_HAS_USER_MEMO;
    }

    let memo_len = memo_bytes.map(|b| b.len()).unwrap_or(0);
    let total_len = 36 + memo_len;
    let mut buf = Vec::with_capacity(total_len);
    buf.push(OMR_MEMO_MAGIC);
    buf.push(scheme);
    buf.push(flags);
    buf.extend_from_slice(&clue_seed);
    buf.push(memo_len as u8);
    if let Some(bytes) = memo_bytes {
        buf.extend_from_slice(bytes);
    }
    Ok(buf)
}

// ---------------------------------------------------------------------------
// Encrypted OMR metadata — off-chain channel via LWD
// ---------------------------------------------------------------------------

#[derive(Clone, Debug)]
struct OmrMetadataBlob(Vec<u8>);

impl Encodable for OmrMetadataBlob {
    fn encode<S: std::io::Write>(&self, s: &mut S) -> std::result::Result<usize, std::io::Error> {
        self.0.encode(s)
    }
}

impl Decodable for OmrMetadataBlob {
    fn decode<D: std::io::Read>(d: &mut D) -> std::result::Result<Self, std::io::Error> {
        let v = Vec::<u8>::decode(d)?;
        Ok(Self(v))
    }
}

/// Encrypt OMR metadata for the recipient via AeadEncryptedNote.
pub fn encrypt_omr_metadata(
    metadata: &[u8],
    recipient_pubkey: &PublicKey,
) -> Result<Vec<u8>, String> {
    let blob = OmrMetadataBlob(metadata.to_vec());
    let mut rng = rand_core::OsRng;
    let enc_note = AeadEncryptedNote::encrypt(&blob, recipient_pubkey, &mut rng)
        .map_err(|e| format!("Failed to encrypt OMR metadata: {e}"))?;
    Ok(serialize(&enc_note))
}

/// Decrypt OMR metadata from CompactOutput.omr_metadata_enc.
pub fn decrypt_omr_metadata(encrypted_bytes: &[u8], secret_key: &SecretKey) -> Option<Vec<u8>> {
    if encrypted_bytes.len() < 48 {
        return None;
    }
    let mut cursor = std::io::Cursor::new(encrypted_bytes);
    let enc_note = AeadEncryptedNote::decode(&mut cursor).ok()?;
    let blob: OmrMetadataBlob = enc_note.decrypt(secret_key).ok()?;
    Some(blob.0)
}

#[cfg(test)]
mod tests {
    use super::*;
    use darkfi_sdk::crypto::{PublicKey, SecretKey};

    #[test]
    fn test_encrypt_omr_metadata_roundtrip() {
        let sk = SecretKey::random(&mut rand_core::OsRng);
        let pk = PublicKey::from_secret(sk);

        let metadata = build_omr_memo(&[0x42; 32], &[0xAB; 32], Some("hello"), None).unwrap();
        let encrypted = encrypt_omr_metadata(&metadata, &pk).unwrap();
        let decrypted = decrypt_omr_metadata(&encrypted, &sk).unwrap();
        assert_eq!(decrypted, metadata);
    }

    #[test]
    fn test_decrypt_wrong_key_fails() {
        let sk1 = SecretKey::random(&mut rand_core::OsRng);
        let pk1 = PublicKey::from_secret(sk1);
        let sk2 = SecretKey::random(&mut rand_core::OsRng);

        let metadata = build_omr_memo(&[0x01; 32], &[0x02; 32], None, None).unwrap();
        let encrypted = encrypt_omr_metadata(&metadata, &pk1).unwrap();
        assert!(decrypt_omr_metadata(&encrypted, &sk2).is_none());
    }
}
