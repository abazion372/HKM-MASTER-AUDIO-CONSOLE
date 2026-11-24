//! `desktop_api_request` — native allowlisted HTTP bridge.
//!
//! Inside the desktop shell the web console calls its own Next.js API routes through this
//! command instead of raw `fetch`, mirroring the contract in `src/hkm/utils/appApi.ts`:
//! `{ method, path, body }` → `{ status, body }`.

use serde::Serialize;

#[derive(Clone, Serialize)]
pub struct DesktopApiResponse {
    pub status: u16,
    pub body: serde_json::Value,
}

pub async fn dispatch(
    http: &reqwest::Client,
    base: &str,
    method: String,
    path: String,
    body: Option<serde_json::Value>,
) -> Result<DesktopApiResponse, String> {
    let url = format!("{}{}", base.trim_end_matches('/'), path);
    let client = match method.to_uppercase().as_str() {
        "GET" => http.get(&url),
        "POST" => http.post(&url),
        "PUT" => http.put(&url),
        "PATCH" => http.patch(&url),
        "DELETE" => http.delete(&url),
        other => return Err(format!("Unsupported desktop API method: {}", other)),
    };
    let client = if let Some(payload) = body {
        client.json(&payload)
    } else {
        client
    };

    let response = client
        .timeout(std::time::Duration::from_secs(60))
        .send()
        .await
        .map_err(|e| format!("Console server request failed ({} {}): {}", method, path, e))?;

    let status = response.status().as_u16();
    let text = response
        .text()
        .await
        .map_err(|e| format!("Console server response read failed ({} {}): {}", method, path, e))?;

    let body = serde_json::from_str::<serde_json::Value>(&text)
        .unwrap_or(serde_json::Value::String(text));

    Ok(DesktopApiResponse { status, body })
}
