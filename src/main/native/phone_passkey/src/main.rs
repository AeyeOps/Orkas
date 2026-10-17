use std::io::{self, BufRead, Read, Write};
use webauthn_authenticator_rs::{cable::connect_cable_authenticator, types::{CableRequestType, CableState, EnrollSampleStatus}, ui::UiCallback, AuthenticatorBackendHashedClientData, prelude::{Url, WebauthnCError}};
use webauthn_rs_proto::PublicKeyCredentialRequestOptions;
use serde_json::{json, Value};
mod qr_svg;
#[derive(Debug)]
struct Ui;
fn event(v: Value) { println!("{}", v); io::stdout().flush().ok(); }
impl UiCallback for Ui {
    fn request_pin(&self) -> Option<String> { None }
    fn request_touch(&self) { event(json!({"type":"state","state":"confirm-on-phone"})); }
    fn processing(&self) { event(json!({"type":"state","state":"processing"})); }
    fn fingerprint_enrollment_feedback(&self, _:u32, _:Option<EnrollSampleStatus>) {}
    fn cable_qr_code(&self, _:CableRequestType, url:String) {
        let svg = qr_svg::passkey_qr_svg(url.as_bytes()).expect("QR encoding");
        event(json!({"type":"qr", "svg":svg}));
    }
    fn dismiss_qr_code(&self) { event(json!({"type":"state","state":"phone-connected"})); }
    fn cable_status_update(&self, state:CableState) { event(json!({"type":"state","state":format!("{:?}",state)})); }
}
#[tokio::main(flavor="multi_thread",worker_threads=2)]
async fn main() {
    if std::env::args().any(|arg| arg == "--version") { println!("orkas-phone-passkey 1"); return; }
    let result = run().await;
    if result.is_err() { event(json!({"type":"error","code":"unavailable"})); std::process::exit(1); }
}
async fn run() -> Result<(), String> {
    let mut line = String::new();
    io::stdin().lock().take(131_200).read_line(&mut line).map_err(|_|"input")?;
    if line.len() >= 131_200 || !line.ends_with('\n') { return Err("input-size".into()); }
    let v: Value = serde_json::from_str(&line).map_err(|_|"input-json")?;
    let origin = Url::parse(v["origin"].as_str().ok_or("origin")?).map_err(|_|"origin")?;
    let options: PublicKeyCredentialRequestOptions = serde_json::from_value(v["publicKey"].clone()).map_err(|_|"options")?;
    let ui = Ui;
    let operation = async {
        let mut authenticator = connect_cable_authenticator(CableRequestType::GetAssertion, &ui).await.map_err(|_|"connect")?;
        // Blocking CTAP facade uses the runtime's worker threads for tunnel I/O.
        let credential = tokio::task::block_in_place(|| perform_browser_auth(&mut authenticator, origin, options)).map_err(|_|"assertion")?;
        event(json!({"type":"result","credential":credential}));
        Ok(())
    };
    tokio::time::timeout(std::time::Duration::from_secs(180), operation).await.map_err(|_|"timeout")?
}

fn perform_browser_auth<T: AuthenticatorBackendHashedClientData>(backend: &mut T, origin: Url, options: PublicKeyCredentialRequestOptions) -> Result<webauthn_rs_proto::PublicKeyCredential, WebauthnCError> {
    // Hash the browser's serialized origin, not URL serialization with a path.
    let client_data = serde_json::to_vec(&json!({
        "type":"webauthn.get", "challenge":options.challenge,
        "origin":origin.origin().ascii_serialization(), "crossOrigin":false
    })).map_err(|_| WebauthnCError::Json)?;
    let hash = openssl::sha::sha256(&client_data).to_vec();
    let mut credential = AuthenticatorBackendHashedClientData::perform_auth(backend, hash, options, 120_000)?;
    credential.response.client_data_json = client_data.into();
    Ok(credential)
}

#[cfg(test)]
mod tests {
    use super::*;
    use webauthn_rs_proto::{PublicKeyCredential, PublicKeyCredentialCreationOptions, RegisterPublicKeyCredential};
    #[derive(Default)]
    struct RecordedAuthenticator { hash: Vec<u8> }
    impl AuthenticatorBackendHashedClientData for RecordedAuthenticator {
        fn perform_register(&mut self, _: Vec<u8>, _: PublicKeyCredentialCreationOptions, _: u32) -> Result<RegisterPublicKeyCredential, WebauthnCError> { Err(WebauthnCError::NotSupported) }
        fn perform_auth(&mut self, hash: Vec<u8>, _: PublicKeyCredentialRequestOptions, _: u32) -> Result<PublicKeyCredential, WebauthnCError> {
            self.hash = hash;
            Ok(serde_json::from_value(json!({"id":"AQ","rawId":"AQ","type":"public-key","response":{"authenticatorData":"AQ","clientDataJSON":"","signature":"AQ","userHandle":null},"extensions":{}})).unwrap())
        }
    }
    #[test]
    fn browser_client_data_has_a_serialized_origin_and_the_signed_hash() {
        let mut backend = RecordedAuthenticator::default();
        let options: PublicKeyCredentialRequestOptions = serde_json::from_value(json!({"challenge":"AAECAwQFBgcICQoLDA0ODw","rpId":"google.com","allowCredentials":[],"userVerification":"required"})).unwrap();
        let credential = perform_browser_auth(&mut backend, Url::parse("https://accounts.google.com").unwrap(), options).unwrap();
        let data = credential.response.client_data_json.as_slice();
        let parsed: Value = serde_json::from_slice(data).unwrap();
        assert_eq!(parsed["origin"], "https://accounts.google.com", "WebAuthn origin is an origin, without a URL path");
        assert_eq!(parsed["crossOrigin"], false);
        assert_eq!(parsed["type"], "webauthn.get");
        assert_eq!(parsed["challenge"], "AAECAwQFBgcICQoLDA0ODw");
        assert!(parsed.get("tokenBinding").is_none());
        assert_eq!(backend.hash, openssl::sha::sha256(data).to_vec(), "The returned bytes must be exactly what the phone signs");
    }
}
