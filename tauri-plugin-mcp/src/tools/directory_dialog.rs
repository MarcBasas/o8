//! Narrow control of the app's existing directory sheet, never a new picker.
use serde::Deserialize;
use serde_json::{Value, json};
use std::path::PathBuf;
use tauri::{AppHandle, Runtime};

use crate::{shared::commands, socket_server::SocketResponse};

#[cfg(target_os = "macos")]
#[path = "directory_dialog_macos.rs"]
mod macos;

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct Inspect {
    #[serde(default = "main_label")]
    window_label: String,
}

fn main_label() -> String {
    "main".into()
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "snake_case")]
pub(super) enum Operation {
    Select,
    Cancel,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct Resolve {
    #[serde(default = "main_label")]
    window_label: String,
    dialog_id: String,
    operation: Operation,
    path: Option<String>,
}

#[derive(Debug)]
pub(super) enum Request {
    Inspect,
    Resolve {
        dialog_id: String,
        operation: Operation,
        path: Option<PathBuf>,
    },
}

pub(super) fn failure(code: &str, reason: &str) -> SocketResponse {
    SocketResponse {
        success: false,
        data: Some(json!({ "code": code, "reason": reason })),
        error: Some(code.into()),
        id: None,
    }
}

pub(super) fn response(data: Value) -> SocketResponse {
    SocketResponse {
        success: true,
        data: Some(data),
        error: None,
        id: None,
    }
}

// Called by the shared socket dispatcher. Validation happens before native work.
fn parse(command: &str, payload: Value) -> Result<Request, SocketResponse> {
    let schema_error = |_| failure("invalid_schema", "Invalid directory dialog payload");
    let label;
    let request = match command {
        commands::INSPECT_DIRECTORY_DIALOG => {
            let params: Inspect = serde_json::from_value(payload).map_err(schema_error)?;
            label = params.window_label;
            Request::Inspect
        }
        commands::RESOLVE_DIRECTORY_DIALOG => {
            let params: Resolve = serde_json::from_value(payload).map_err(schema_error)?;
            label = params.window_label;
            if params.dialog_id.is_empty() {
                return Err(failure(
                    "invalid_identity",
                    "Inspection identity is required",
                ));
            }
            let path = match (&params.operation, params.path) {
                (Operation::Select, Some(path)) => Some(validate_path(&path)?),
                (Operation::Cancel, None) => None,
                _ => {
                    return Err(failure(
                        "invalid_operation",
                        "Select requires path; cancel forbids path",
                    ));
                }
            };
            Request::Resolve {
                dialog_id: params.dialog_id,
                operation: params.operation,
                path,
            }
        }
        _ => {
            return Err(failure(
                "unknown_command",
                "Unknown directory dialog command",
            ));
        }
    };
    if label != "main" {
        return Err(failure("wrong_window", "Only the main window is supported"));
    }
    Ok(request)
}

pub(super) fn validate_path(path: &str) -> Result<PathBuf, SocketResponse> {
    let candidate = PathBuf::from(path);
    if path.contains('\0') || !candidate.is_absolute() || !candidate.is_dir() {
        return Err(failure(
            "invalid_path",
            "An absolute existing directory is required",
        ));
    }
    candidate
        .canonicalize()
        .map_err(|_| failure("invalid_path", "Directory cannot be resolved"))
}

// Shared identity/type policy, also exercised through the socket dispatcher.
pub(super) fn check_live(
    is_panel: bool,
    attached_to_main: bool,
    visible: bool,
    directories: bool,
    files: bool,
    multiple: bool,
) -> Result<(), SocketResponse> {
    if !is_panel || !attached_to_main || !visible || !directories || files || multiple {
        return Err(failure(
            "wrong_dialog_type",
            "Only a live single-directory NSOpenPanel attached to main is supported",
        ));
    }
    Ok(())
}

pub(super) fn check_identity(
    current: &str,
    supplied: &str,
    claimed: bool,
    dispatched: bool,
    operation: &Operation,
) -> Result<(), SocketResponse> {
    if current != supplied {
        return Err(failure(
            "stale_dialog",
            "Inspect the current dialog before resolving",
        ));
    }
    if claimed && !(matches!(operation, Operation::Cancel) && !dispatched) {
        return Err(failure(
            "already_accepted",
            "Resolve was already accepted; inspect and reconcile setup status, do not retry",
        ));
    }
    Ok(())
}

#[cfg(test)]
pub(super) mod fixture {
    use super::*;
    pub static SERIAL: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());
    pub struct Panel {
        pub identity: &'static str,
        pub claimed: bool,
        pub dispatched: bool,
        pub flags: [bool; 6],
    }
    pub static PANEL: std::sync::Mutex<Option<Panel>> = std::sync::Mutex::new(None);
    pub fn handle(request: &Request) -> Option<SocketResponse> {
        let mut slot = PANEL.lock().unwrap();
        let panel = slot.as_mut()?;
        let [is_panel, attached, visible, directories, files, multiple] = panel.flags;
        if let Err(error) = check_live(is_panel, attached, visible, directories, files, multiple) {
            return Some(error);
        }
        if let Request::Resolve {
            dialog_id,
            operation,
            ..
        } = request
        {
            if let Err(error) = check_identity(
                panel.identity,
                dialog_id,
                panel.claimed,
                panel.dispatched,
                operation,
            ) {
                return Some(error);
            }
            panel.claimed = true;
            panel.dispatched = matches!(operation, Operation::Cancel);
        }
        Some(response(
            json!({ "dialog_id":panel.identity, "status": if panel.claimed { "pending" } else { "live" } }),
        ))
    }
}

pub async fn handle<R: Runtime>(
    app: &AppHandle<R>,
    command: &str,
    payload: Value,
) -> crate::Result<SocketResponse> {
    let request = match parse(command, payload) {
        Ok(request) => request,
        Err(error) => return Ok(error),
    };
    #[cfg(test)]
    if let Some(result) = fixture::handle(&request) {
        return Ok(result);
    }
    #[cfg(target_os = "macos")]
    {
        macos::handle(app, request).await
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (app, request);
        Ok(failure(
            "unsupported_os",
            "Directory dialog control requires macOS",
        ))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn shared_commands_validate_schema_and_path_before_native_dispatch() {
        assert!(matches!(
            parse(commands::INSPECT_DIRECTORY_DIALOG, json!({})),
            Ok(Request::Inspect)
        ));
        for payload in [json!({"operation":"cancel"}), json!({"window_label":3})] {
            assert_eq!(
                parse(commands::INSPECT_DIRECTORY_DIALOG, payload)
                    .unwrap_err()
                    .error
                    .as_deref(),
                Some("invalid_schema")
            );
        }
        assert_eq!(
            parse(
                commands::INSPECT_DIRECTORY_DIALOG,
                json!({"window_label":"dock"})
            )
            .unwrap_err()
            .error
            .as_deref(),
            Some("wrong_window")
        );
        for path in ["relative", "/does-not-exist-3138", "/tmp/\0bad"] {
            assert_eq!(
                parse(
                    commands::RESOLVE_DIRECTORY_DIALOG,
                    json!({"dialog_id":"opaque", "operation":"select", "path":path})
                )
                .unwrap_err()
                .error
                .as_deref(),
                Some("invalid_path")
            );
        }
        let file = std::env::current_exe().unwrap();
        assert!(validate_path(file.to_str().unwrap()).is_err());
        let directory = std::env::temp_dir();
        assert!(
            parse(
                commands::RESOLVE_DIRECTORY_DIALOG,
                json!({"dialog_id":"opaque", "operation":"select", "path":directory})
            )
            .is_ok()
        );
        for payload in [
            json!({"dialog_id":"opaque", "operation":"select"}),
            json!({"dialog_id":"opaque", "operation":"cancel", "path":"/tmp"}),
            json!({"dialog_id":"opaque", "operation":"click"}),
            json!({"dialog_id":123, "operation":"cancel"}),
            json!({"operation":"cancel"}),
        ] {
            assert!(parse(commands::RESOLVE_DIRECTORY_DIALOG, payload).is_err());
        }
    }
}
