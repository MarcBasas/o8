//! Command supervisor for the o8 Pi SDK worker (#3350).
//!
//! `o8-pi-write supervise <program> [args...]` runs one approved command and
//! ends every process it starts. On Linux the supervisor marks itself a child
//! subreaper, so any descendant whose parent exits is reparented to the
//! supervisor instead of init, whatever process group or session it moved to.
//! Every descendant therefore stays reachable by walking parent links in /proc
//! from the supervisor, and it is done only when `waitpid` reports no children.
//!
//! The command runs in its own process group. When it exits, or the host sends
//! SIGTERM, SIGINT or SIGHUP, the supervisor sends TERM to every descendant,
//! waits up to 1.5 seconds, then sends KILL until none is left. If the host
//! dies, the parent-death signal starts the same teardown.
//!
//! The receipt goes to fd 3, never to the command: one JSON line with the
//! command's exit code or signal and whether teardown was confirmed.

use std::ffi::OsString;
#[cfg(target_os = "linux")]
use std::ffi::CString;
#[cfg(target_os = "linux")]
use std::os::unix::ffi::OsStrExt;
#[cfg(target_os = "linux")]
use std::time::{Duration, Instant};

#[cfg(target_os = "linux")]
const RECEIPT: libc::c_int = 3;

#[cfg(target_os = "linux")]
fn children_by_parent() -> std::collections::HashMap<libc::pid_t, Vec<libc::pid_t>> {
    let mut map: std::collections::HashMap<libc::pid_t, Vec<libc::pid_t>> = std::collections::HashMap::new();
    let Ok(entries) = std::fs::read_dir("/proc") else { return map };
    for entry in entries.flatten() {
        let Ok(pid) = entry.file_name().to_string_lossy().parse::<libc::pid_t>() else { continue };
        let Ok(stat) = std::fs::read_to_string(format!("/proc/{pid}/stat")) else { continue };
        // The command name may contain spaces and parentheses; fields resume after the last ')'.
        let Some(rest) = stat.rfind(')').map(|at| &stat[at + 1..]) else { continue };
        let mut fields = rest.split_whitespace();
        let state = fields.next();
        let Some(ppid) = fields.next().and_then(|value| value.parse::<libc::pid_t>().ok()) else { continue };
        // Zombies are already dead and only wait to be reaped.
        if state == Some("Z") {
            continue;
        }
        map.entry(ppid).or_default().push(pid);
    }
    map
}

#[cfg(target_os = "linux")]
fn descendants() -> Vec<libc::pid_t> {
    let map = children_by_parent();
    let mut found = Vec::new();
    let mut pending = vec![unsafe { libc::getpid() }];
    while let Some(parent) = pending.pop() {
        for child in map.get(&parent).into_iter().flatten() {
            found.push(*child);
            pending.push(*child);
        }
    }
    found
}

/// Reaps every exited child; records the command's status when it is among them.
#[cfg(target_os = "linux")]
fn reap(command: libc::pid_t, status: &mut Option<libc::c_int>) -> bool {
    loop {
        let mut raw = 0;
        let pid = unsafe { libc::waitpid(-1, &mut raw, libc::WNOHANG) };
        if pid == command {
            *status = Some(raw);
        }
        if pid > 0 {
            continue;
        }
        // ECHILD: no child is left, live or zombie.
        return pid < 0 && std::io::Error::last_os_error().raw_os_error() == Some(libc::ECHILD);
    }
}

#[cfg(target_os = "linux")]
fn wait_signal(set: &libc::sigset_t, timeout: Duration) -> libc::c_int {
    let spec = libc::timespec { tv_sec: timeout.as_secs() as libc::time_t, tv_nsec: timeout.subsec_nanos() as libc::c_long };
    unsafe { libc::sigtimedwait(set, std::ptr::null_mut(), &spec) }
}

#[cfg(target_os = "linux")]
fn signal_all(signal: libc::c_int) -> bool {
    let found = descendants();
    for pid in &found {
        unsafe { libc::kill(*pid, signal) };
    }
    !found.is_empty()
}

/// TERM, a grace period, then KILL until `waitpid` reports no child. Returns
/// false only if processes outlive the final deadline (for example a process
/// stuck in uninterruptible sleep).
#[cfg(target_os = "linux")]
fn teardown(set: &libc::sigset_t, command: libc::pid_t, status: &mut Option<libc::c_int>) -> bool {
    signal_all(libc::SIGTERM);
    let grace = Instant::now() + Duration::from_millis(1_500);
    while Instant::now() < grace {
        if reap(command, status) {
            return true;
        }
        wait_signal(set, Duration::from_millis(50));
    }
    let deadline = Instant::now() + Duration::from_secs(5);
    while Instant::now() < deadline {
        signal_all(libc::SIGKILL);
        if reap(command, status) {
            return true;
        }
        wait_signal(set, Duration::from_millis(20));
    }
    reap(command, status)
}

#[cfg(target_os = "linux")]
fn write_receipt(status: Option<libc::c_int>, confirmed: bool) {
    let (code, signal) = match status {
        Some(raw) if libc::WIFEXITED(raw) => (Some(libc::WEXITSTATUS(raw)), None),
        Some(raw) if libc::WIFSIGNALED(raw) => (None, Some(libc::WTERMSIG(raw))),
        _ => (None, None),
    };
    let line = serde_json::json!({ "code": code, "signal": signal, "confirmed": confirmed }).to_string() + "\n";
    unsafe { libc::write(RECEIPT, line.as_ptr().cast(), line.len()) };
}

#[cfg(not(target_os = "linux"))]
pub fn run(_argv: &[OsString]) -> i32 {
    // No subreaper on this platform; the host uses its own best-effort tracker.
    eprintln!("The command supervisor is available on Linux only.");
    125
}

#[cfg(target_os = "linux")]
pub fn run(argv: &[OsString]) -> i32 {
    if argv.is_empty() {
        return 125;
    }
    let Ok(program) = argv.iter().map(|arg| CString::new(arg.as_bytes())).collect::<Result<Vec<_>, _>>() else {
        return 125;
    };
    unsafe {
        // The command never sees the receipt descriptor.
        libc::fcntl(RECEIPT, libc::F_SETFD, libc::FD_CLOEXEC);
        if libc::prctl(libc::PR_SET_CHILD_SUBREAPER, 1, 0, 0, 0) != 0
            || libc::prctl(libc::PR_SET_PDEATHSIG, libc::SIGTERM, 0, 0, 0) != 0
        {
            write_receipt(None, false);
            return 125;
        }
    }
    let host = unsafe { libc::getppid() };
    let mut set: libc::sigset_t = unsafe { std::mem::zeroed() };
    let mut previous: libc::sigset_t = unsafe { std::mem::zeroed() };
    unsafe {
        libc::sigemptyset(&mut set);
        for signal in [libc::SIGCHLD, libc::SIGTERM, libc::SIGINT, libc::SIGHUP] {
            libc::sigaddset(&mut set, signal);
        }
        libc::sigprocmask(libc::SIG_BLOCK, &set, &mut previous);
    }
    let mut pointers: Vec<*const libc::c_char> = program.iter().map(|arg| arg.as_ptr()).collect();
    pointers.push(std::ptr::null());
    let command = unsafe { libc::fork() };
    if command < 0 {
        write_receipt(None, false);
        return 125;
    }
    if command == 0 {
        unsafe {
            libc::setpgid(0, 0);
            libc::sigprocmask(libc::SIG_SETMASK, &previous, std::ptr::null_mut());
            libc::execv(pointers[0], pointers.as_ptr());
            libc::_exit(127);
        }
    }
    let mut status = None;
    // The host may have died before the parent-death signal was armed.
    let mut stop = unsafe { libc::getppid() } != host;
    while !stop {
        let signal = wait_signal(&set, Duration::from_millis(250));
        reap(command, &mut status);
        stop = status.is_some() || matches!(signal, libc::SIGTERM | libc::SIGINT | libc::SIGHUP);
    }
    let confirmed = teardown(&set, command, &mut status);
    write_receipt(status, confirmed);
    match status {
        Some(raw) if libc::WIFEXITED(raw) => libc::WEXITSTATUS(raw),
        Some(raw) if libc::WIFSIGNALED(raw) => 128 + libc::WTERMSIG(raw),
        _ => 125,
    }
}
