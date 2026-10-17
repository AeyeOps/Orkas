//! Orkas initiator-only transport. Chromium owns network policy; this process
//! receives only encrypted WebSocket frames over its inherited stdio pipes.
use std::io::{self, BufRead, Read, Write};
use serde_json::{json, Value};
use tokio_tungstenite::tungstenite::Message;
use crate::prelude::WebauthnCError;

const MAX_LINE: u64 = 131_200;
fn emit(value: Value) -> Result<(), WebauthnCError> {
    let mut output = io::stdout().lock();
    writeln!(output, "{}", value).and_then(|_| output.flush()).map_err(|_| WebauthnCError::Closed)
}
async fn read() -> Result<Value, WebauthnCError> {
    tokio::task::spawn_blocking(|| {
        let mut line = String::new();
        let size = io::stdin().lock().take(MAX_LINE).read_line(&mut line).map_err(|_| WebauthnCError::Closed)?;
        if size == 0 || size as u64 >= MAX_LINE || !line.ends_with('\n') { return Err(WebauthnCError::Closed); }
        serde_json::from_str(&line).map_err(|_| WebauthnCError::Json)
    }).await.map_err(|_| WebauthnCError::Internal)?
}

#[derive(Debug)]
pub(crate) struct IpcSocket;
impl IpcSocket {
    pub(super) async fn connect(uri: &str) -> Result<Self, WebauthnCError> {
        emit(json!({"type":"ws-open", "url":uri}))?;
        if read().await?["type"] != "ws-opened" { return Err(WebauthnCError::Closed); }
        Ok(Self)
    }
    pub(super) async fn send(&mut self, message: Message) -> Result<(), WebauthnCError> {
        match message {
            Message::Binary(data) if data.len() <= 65_536 => emit(json!({"type":"ws-send", "hex":hex::encode(data)})),
            _ => Err(WebauthnCError::NotSupported),
        }
    }
    pub(super) async fn next(&mut self) -> Option<Result<Message, WebauthnCError>> {
        Some(match read().await {
            Ok(value) if value["type"] == "ws-message" => value["hex"].as_str()
                .filter(|s| s.len() <= 131_072 && s.len() % 2 == 0)
                .and_then(|s| hex::decode(s).ok())
                .map(|bytes| Message::Binary(bytes.into())).ok_or(WebauthnCError::Json),
            _ => Err(WebauthnCError::Closed),
        })
    }
    pub(super) async fn close(&mut self, _: Option<()>) -> Result<(), WebauthnCError> {
        emit(json!({"type":"ws-close"}))
    }
}
