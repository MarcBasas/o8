//! AppKit is accessed only on the application's main thread. No accessibility,
//! global input, JS evaluation, delegate replacement, or permission changes.
use serde_json::json;
use std::{
    cell::RefCell,
    ffi::{CStr, CString, c_void},
    time::{Duration, Instant},
};
use tauri::{AppHandle, Manager, Runtime};
use tokio::sync::oneshot;

use super::{Operation, Request, check_identity, check_live, failure, response, validate_path};
use crate::socket_server::SocketResponse;

#[path = "directory_dialog_lifecycle.rs"]
mod lifecycle;

type Id = *mut c_void;
type Sel = *mut c_void;
#[link(name = "objc", kind = "dylib")]
unsafe extern "C" {
    fn objc_getClass(name: *const u8) -> Id;
    fn sel_registerName(name: *const u8) -> Sel;
    fn objc_msgSend();
}
unsafe fn get(object: Id, selector: &[u8]) -> Id {
    let send: unsafe extern "C" fn(Id, Sel) -> Id =
        unsafe { std::mem::transmute(objc_msgSend as *const c_void) };
    unsafe { send(object, sel_registerName(selector.as_ptr())) }
}
unsafe fn flag(object: Id, selector: &[u8]) -> bool {
    let send: unsafe extern "C" fn(Id, Sel) -> i8 =
        unsafe { std::mem::transmute(objc_msgSend as *const c_void) };
    unsafe { send(object, sel_registerName(selector.as_ptr())) != 0 }
}
unsafe fn arg(object: Id, selector: &[u8], value: Id) {
    let send: unsafe extern "C" fn(Id, Sel, Id) =
        unsafe { std::mem::transmute(objc_msgSend as *const c_void) };
    unsafe { send(object, sel_registerName(selector.as_ptr()), value) }
}
unsafe fn is_open_panel(panel: Id) -> bool {
    let send: unsafe extern "C" fn(Id, Sel, Id) -> i8 =
        unsafe { std::mem::transmute(objc_msgSend as *const c_void) };
    unsafe {
        send(
            panel,
            sel_registerName(b"isKindOfClass:\0".as_ptr()),
            objc_getClass(b"NSOpenPanel\0".as_ptr()),
        ) != 0
    }
}
unsafe fn url_path(panel: Id, selector: &[u8]) -> Option<std::path::PathBuf> {
    unsafe {
        let url = get(panel, selector);
        if url.is_null() {
            return None;
        }
        let string = get(url, b"path\0");
        let bytes = get(string, b"UTF8String\0") as *const i8;
        if bytes.is_null() {
            return None;
        }
        validate_path(CStr::from_ptr(bytes).to_str().ok()?).ok()
    }
}

struct Current {
    window: Id,
    panel: Id,
    identity: String,
    epoch: u64,
    // A resolve identity is single-use, including navigation that stays pending.
    requested: Option<std::path::PathBuf>,
    claimed: bool,
    dispatched: bool,
}
impl Drop for Current {
    fn drop(&mut self) {
        // This thread-local is only touched by main-thread closures.
        unsafe {
            get(self.panel, b"release\0");
            get(self.window, b"release\0");
        }
    }
}
thread_local! { static CURRENT: RefCell<Option<Current>> = const { RefCell::new(None) }; }

// Retaining both objects prevents pointer reuse from turning a stale identity
// into authority over a replacement panel/window. Missing sheets invalidate it.
unsafe fn current(window: Id, slot: &mut Option<Current>) -> Result<&mut Current, SocketResponse> {
    unsafe {
        let epoch = lifecycle::epoch(window).map_err(|_| {
            failure(
                "lifecycle_unavailable",
                "Cannot establish native dialog presentation identity",
            )
        })?;
        let panel = get(window, b"attachedSheet\0");
        if panel.is_null() {
            *slot = None;
            return Err(failure(
                "no_dialog",
                "No attached sheet; read normal setup status to reconcile any pending outcome",
            ));
        }
        if slot
            .as_ref()
            .is_some_and(|old| old.window != window || old.panel != panel || old.epoch != epoch)
        {
            *slot = None;
        }
        if let Err(error) = check_live(
            is_open_panel(panel),
            get(panel, b"sheetParent\0") == window,
            flag(panel, b"isVisible\0"),
            flag(panel, b"canChooseDirectories\0"),
            flag(panel, b"canChooseFiles\0"),
            flag(panel, b"allowsMultipleSelection\0"),
        ) {
            *slot = None;
            return Err(error);
        }
        if slot.is_none() {
            get(window, b"retain\0");
            get(panel, b"retain\0");
            *slot = Some(Current {
                window,
                panel,
                identity: uuid::Uuid::new_v4().to_string(),
                epoch,
                requested: None,
                claimed: false,
                dispatched: false,
            });
        }
        Ok(slot.as_mut().unwrap())
    }
}

enum Step {
    Request(Request),
    Continue(String),
}

async fn on_main<R: Runtime>(app: &AppHandle<R>, step: Step) -> SocketResponse {
    let (tx, rx) = oneshot::channel();
    let app_copy = app.clone();
    let deadline = Instant::now() + Duration::from_secs(2);
    if app.run_on_main_thread(move || {
        // A timed-out queued closure must never perform a later mutation.
        if Instant::now() >= deadline || tx.is_closed() { return; }
        let result = (|| {
            let window = app_copy.get_webview_window("main").ok_or_else(|| {
                CURRENT.with(|slot| *slot.borrow_mut() = None);
                failure("missing_window", "Main window no longer exists")
            })?;
            let native = window.ns_window().map_err(|_| failure("missing_window", "Main native window is unavailable"))?;
            CURRENT.with(|slot| unsafe {
                let mut slot = slot.borrow_mut();
                let state = current(native, &mut slot)?;
                match step {
                    Step::Request(Request::Inspect) => Ok(response(json!({
                        "dialog_id": state.identity, "window_label": "main", "status": if state.claimed { "pending" } else { "live" },
                        "requested_path": state.requested, "selection_path": url_path(state.panel, b"URL\0"),
                        "action_dispatched": state.dispatched,
                        "reason": "Panel state alone does not prove callback or workspace completion"
                    }))),
                    Step::Request(Request::Resolve { dialog_id, operation, path }) => {
                        check_identity(&state.identity, &dialog_id, state.claimed, state.dispatched, &operation)?;
                        match operation {
                            Operation::Cancel => {
                                state.claimed = true;
                                state.dispatched = true;
                                arg(state.panel, b"cancel:\0", std::ptr::null_mut());
                            }
                            Operation::Select => {
                                let path = path.unwrap();
                                let path = validate_path(path.to_str().ok_or_else(|| failure("invalid_path", "Directory path must be UTF-8"))?)?;
                                let encoded = CString::new(path.to_str().unwrap()).map_err(|_| failure("invalid_path", "Invalid directory path"))?;
                                let send_string: unsafe extern "C" fn(Id, Sel, *const i8) -> Id = std::mem::transmute(objc_msgSend as *const c_void);
                                let string = send_string(objc_getClass(b"NSString\0".as_ptr()), sel_registerName(b"stringWithUTF8String:\0".as_ptr()), encoded.as_ptr());
                                let send_url: unsafe extern "C" fn(Id, Sel, Id, i8) -> Id = std::mem::transmute(objc_msgSend as *const c_void);
                                let url = send_url(objc_getClass(b"NSURL\0".as_ptr()), sel_registerName(b"fileURLWithPath:isDirectory:\0".as_ptr()), string, 1);
                                if url.is_null() { return Err(failure("invalid_path", "Cannot create directory URL")); }
                                state.claimed = true;
                                state.requested = Some(path);
                                arg(state.panel, b"setDirectoryURL:\0", url);
                            }
                        }
                        Ok(pending(state))
                    }
                    Step::Continue(identity) => {
                        if identity != state.identity { return Err(failure("stale_dialog", "Dialog changed during selection; no further action taken")); }
                        if !state.dispatched {
                            if let Some(path) = state.requested.as_ref() {
                                // Navigation is asynchronous. Never press OK for a different selection.
                                if url_path(state.panel, b"directoryURL\0").as_ref() == Some(path)
                                    && url_path(state.panel, b"URL\0").as_ref() == Some(path) {
                                    state.dispatched = true;
                                    arg(state.panel, b"ok:\0", std::ptr::null_mut());
                                }
                            }
                        }
                        Ok(pending(state))
                    }
                }
            })
        })();
        let _ = tx.send(result.unwrap_or_else(|error| error));
    }).is_err() { return failure("main_thread_unavailable", "Native operation was not queued"); }
    match tokio::time::timeout(Duration::from_secs(2), rx).await {
        Ok(Ok(result)) => result,
        _ => failure(
            "outcome_unknown",
            "Main-thread response unavailable; inspect and read setup status, never retry mutation",
        ),
    }
}
fn pending(state: &Current) -> SocketResponse {
    response(
        json!({ "dialog_id": state.identity, "status": "pending", "accepted": true,
        "action_dispatched": state.dispatched, "requested_path": state.requested,
        "reason": if state.dispatched { "Native action dispatched; panel callback and workspace outcome require observation" } else { "Directory navigation accepted; matching native selection has not been observed" },
        "next": "inspect_directory_dialog then normal setup status" }),
    )
}

pub(super) async fn handle<R: Runtime>(
    app: &AppHandle<R>,
    request: Request,
) -> crate::Result<SocketResponse> {
    let select_identity = match &request {
        Request::Resolve {
            dialog_id,
            operation: Operation::Select,
            ..
        } => Some(dialog_id.clone()),
        _ => None,
    };
    let mut result = on_main(app, Step::Request(request)).await;
    if let Some(identity) = select_identity {
        // Bounded continuation of this single accepted request, never a socket retry.
        for _ in 0..20 {
            if !result.success
                || result
                    .data
                    .as_ref()
                    .and_then(|v| v["action_dispatched"].as_bool())
                    == Some(true)
            {
                break;
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
            result = on_main(app, Step::Continue(identity.clone())).await;
        }
    }
    Ok(result)
}
