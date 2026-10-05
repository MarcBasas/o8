import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { constants, type Stats } from 'node:fs';
import { lstat, mkdir, mkdtemp, open, realpath } from 'node:fs/promises';
import { devNull } from 'node:os';
import path from 'node:path';
import { Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

import { getDataDir } from '@/lib/data-dir-migration';
import {
  assertWorktreeMaterializationIdentity,
  captureWorktreeMaterializationIdentity,
  type WorktreeMaterializationIdentity,
} from '@/lib/worktree/materialization-identity';
import { guardedWorkspaceInvocation, materializationAwareExecFile, withWorktreeMaterializationExecution } from '@/lib/worktree/materialization-execution';
import type { WorkspaceSnapshotRecord } from '@/lib/worktree/snapshot-state';

const MAX_BUNDLE_BYTES = 512 * 1024 * 1024;

function descriptorPath(fd: number): string {
  return (process.platform === 'linux' ? '/proc/self/fd/' : '/dev/fd/') + fd;
}

export interface WorkspaceGitBundleReceipt {
  schema: 'o8/workspace-git-bundle/v1';
  sha256: string;
  bytes: number;
  objectFormat: 'sha1' | 'sha256';
  repositoryUuid: string;
  packetId: string;
  snapshotGeneration: number;
  snapshotFingerprint: string;
  headCommit: string;
  treeSha: string;
  recoveryRef: string;
  prerequisiteCount: 0;
  commitCount: number;
  objectCount: number;
}

function gitEnvironment(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (key.startsWith('GIT_')) delete env[key];
  delete env.NODE_OPTIONS;
  return { ...env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: devNull,
    GIT_TERMINAL_PROMPT: '0', GIT_NO_REPLACE_OBJECTS: '1', GIT_NO_LAZY_FETCH: '1', GIT_OPTIONAL_LOCKS: '0' };
}

function gitArguments(args: string[]): string[] {
  return ['-c', 'core.fsmonitor=false', '-c', 'core.hooksPath=', ...args];
}

async function privateDirectory(directory: string): Promise<WorktreeMaterializationIdentity> {
  await mkdir(directory, { mode: 0o700 }).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== 'EEXIST') throw error;
  });
  const stat = await lstat(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0
    || (process.getuid && stat.uid !== process.getuid()) || await realpath(directory) !== directory) {
    throw new Error('The private Git preservation directory has unsafe ownership.');
  }
  return captureWorktreeMaterializationIdentity(directory);
}

async function bundleDirectory() {
  const data = await realpath(getDataDir());
  const bank = path.join(data, 'workspace-preservation');
  const bankIdentity = await privateDirectory(bank);
  const directory = path.join(bank, 'git-bundles');
  const identity = await privateDirectory(directory);
  await assertWorktreeMaterializationIdentity(bank, bankIdentity);
  return { directory, identity, bankIdentity };
}

async function assertBank(bank: Awaited<ReturnType<typeof bundleDirectory>>) {
  await assertWorktreeMaterializationIdentity(path.dirname(bank.directory), bank.bankIdentity);
  await assertWorktreeMaterializationIdentity(bank.directory, bank.identity);
}

function sameFile(before: Stats, after: Stats): boolean {
  return before.dev === after.dev && before.ino === after.ino && before.size === after.size
    && before.mode === after.mode && before.uid === after.uid && before.nlink === after.nlink
    && before.mtimeMs === after.mtimeMs && before.ctimeMs === after.ctimeMs;
}

async function readBundleFile(candidate: string): Promise<{ content: Buffer; stat: Stats; sha256: string }> {
  const file = await open(candidate, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = await file.stat();
    if (!before.isFile() || before.nlink !== 1 || before.size < 1 || before.size > MAX_BUNDLE_BYTES
      || (before.mode & 0o077) !== 0 || (process.getuid && before.uid !== process.getuid())) {
      throw new Error('The Git bundle exceeds its bound or has unsafe file ownership.');
    }
    const content = Buffer.alloc(before.size);
    let offset = 0;
    while (offset < content.length) {
      const { bytesRead } = await file.read(content, offset, content.length - offset, offset);
      if (!bytesRead) throw new Error('The Git bundle changed during descriptor read.');
      offset += bytesRead;
    }
    const after = await file.stat();
    const named = await lstat(candidate);
    if (!sameFile(before, after) || !sameFile(after, named) || named.isSymbolicLink()) {
      throw new Error('The private Git bundle changed during receipt verification.');
    }
    return { content, stat: after, sha256: createHash('sha256').update(content).digest('hex') };
  } finally {
    await file.close();
  }
}

export async function readWorkspaceGitBundle(receipt: WorkspaceGitBundleReceipt): Promise<Buffer> {
  const oid = receipt.objectFormat === 'sha1' ? /^[a-f0-9]{40}$/ : /^[a-f0-9]{64}$/;
  if (receipt.schema !== 'o8/workspace-git-bundle/v1' || !/^[a-f0-9]{64}$/.test(receipt.sha256)
    || !Number.isSafeInteger(receipt.bytes) || receipt.bytes < 1 || receipt.bytes > MAX_BUNDLE_BYTES
    || !['sha1', 'sha256'].includes(receipt.objectFormat) || !oid.test(receipt.headCommit) || !oid.test(receipt.treeSha)
    || !Number.isSafeInteger(receipt.commitCount) || receipt.commitCount < 1
    || !Number.isSafeInteger(receipt.objectCount) || receipt.objectCount < receipt.commitCount
    || receipt.prerequisiteCount !== 0 || !Number.isSafeInteger(receipt.snapshotGeneration) || receipt.snapshotGeneration < 1
    || !receipt.recoveryRef.startsWith('refs/o8/recovery/')) {
    throw new Error('The portable Git bundle receipt is invalid.');
  }
  const bank = await bundleDirectory();
  const result = await readBundleFile(path.join(bank.directory, receipt.sha256 + '.bundle'));
  await assertBank(bank);
  if (result.sha256 !== receipt.sha256 || result.content.length !== receipt.bytes) {
    throw new Error('The portable Git bundle failed its trusted hash or size receipt.');
  }
  return result.content;
}

async function gitValue(cwd: string, identity: WorktreeMaterializationIdentity, args: string[]): Promise<string> {
  return withWorktreeMaterializationExecution(cwd, identity, async () => {
    const { stdout } = await materializationAwareExecFile('git', gitArguments(args), {
      cwd, env: gitEnvironment(), timeout: 120_000, maxBuffer: 32 * 1024 * 1024,
    });
    return stdout.trim();
  });
}

async function createBundle(snapshot: WorkspaceSnapshotRecord, repositoryPath: string,
  repositoryIdentity: WorktreeMaterializationIdentity, preparation: string, identity: WorktreeMaterializationIdentity) {
  const parent = await open(preparation, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  let file: Awaited<ReturnType<typeof open>> | null = null;
  try {
    const captured = await parent.stat();
    if (!captured.isDirectory() || captured.dev !== identity.device || captured.ino !== identity.inode
      || (captured.mode & 0o077) !== 0 || (process.getuid && captured.uid !== process.getuid())) {
      throw new Error('Private bundle capture lost its preparation directory owner.');
    }
    file = await open(path.join(descriptorPath(parent.fd), 'source.bundle'),
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    const destination = file;
    const invocation = guardedWorkspaceInvocation('git', gitArguments([
      'bundle', 'create', '--version=3', '-', snapshot.recoveryRef,
    ]), repositoryIdentity);
    const child = spawn(invocation.command, invocation.args, {
      cwd: repositoryPath, env: gitEnvironment(), stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
    });
    let bytes = 0;
    let stderrBytes = 0;
    child.stderr.on('data', (chunk: Buffer) => {
      stderrBytes += chunk.length;
      if (stderrBytes > 1024 * 1024) child.kill();
    });
    const timer = setTimeout(() => child.kill(), 120_000);
    const completed = new Promise<void>((resolve, reject) => {
      child.once('error', reject);
      child.once('close', (code) => code === 0 ? resolve() : reject(new Error('Portable Git bundle creation failed; the source remains retained.')));
    });
    const written = pipeline(child.stdout, new Writable({
      write(chunk: Buffer, _encoding, callback) {
        bytes += chunk.length;
        if (bytes > MAX_BUNDLE_BYTES) callback(new Error('Portable Git source exceeds the bounded preservation budget.'));
        else {
          const writeChunk = async () => {
            let offset = 0;
            while (offset < chunk.length) {
              const { bytesWritten } = await destination.write(chunk, offset, chunk.length - offset);
              if (!bytesWritten) throw new Error('Portable Git bundle descriptor write was incomplete.');
              offset += bytesWritten;
            }
          };
          void writeChunk().then(() => callback(), (error: Error) => callback(error));
        }
      },
    }));
    try {
      await Promise.all([completed, written]);
      await destination.sync();
    } catch (error) {
      child.kill();
      await Promise.allSettled([completed, written]);
      throw error;
    } finally {
      clearTimeout(timer);
    }
  } finally {
    try { await file?.close(); } finally { await parent.close(); }
  }
}

// Both publication and disposal act from the OS-captured private bank cwd.
// A replaced verifier directory is retained rather than recursively removed.
const BANK_OPERATION = String.raw`
const fs = require('node:fs');
const path = require('node:path');
const input = JSON.parse(process.argv[1]);
function fdPath(fd) { return (process.platform === 'linux' ? '/proc/self/fd/' : '/dev/fd/') + fd; }
function owned(stat, expected) {
  return stat.isDirectory() && !stat.isSymbolicLink() && !(stat.mode & 0o077)
    && (!process.getuid || stat.uid === process.getuid())
    && stat.dev === expected.device && stat.ino === expected.inode;
}
if (!/^\.prepare-[a-zA-Z0-9]+$/.test(input.leaf)) throw new Error('Verifier name is invalid.');
const bankFd = fs.openSync('.', fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
const tempStat = fs.lstatSync(input.leaf);
if (!owned(tempStat, input.identity)) throw new Error('Private verifier ownership changed; inspect the retained directory.');
const tempFd = fs.openSync(input.leaf, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
try {
  if (!owned(fs.fstatSync(tempFd), input.identity)) throw new Error('Private verifier ownership changed.');
  if (input.operation === 'publish') {
    if (!/^[a-f0-9]{64}$/.test(input.sha256)) throw new Error('Bundle hash is invalid.');
    process.chdir(fdPath(tempFd));
    const stat = fs.lstatSync('source.bundle');
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || (stat.mode & 0o077)
      || stat.dev !== input.file.device || stat.ino !== input.file.inode) throw new Error('Bundle publication ownership changed.');
    try {
      fs.linkSync('source.bundle', path.join(fdPath(bankFd), input.sha256 + '.bundle'));
      fs.unlinkSync('source.bundle');
    } catch (error) { if (error.code !== 'EEXIST') throw error; }
    fs.fsyncSync(bankFd);
  } else if (input.operation === 'remove') {
    process.chdir(fdPath(tempFd));
    for (const name of fs.readdirSync('.')) fs.rmSync(name, { recursive: true, force: false });
    process.chdir(fdPath(bankFd));
    if (!owned(fs.lstatSync(input.leaf), input.identity)) throw new Error('Verifier name changed before final removal.');
    fs.rmdirSync(input.leaf);
    fs.fsyncSync(bankFd);
  } else throw new Error('Private bank operation is invalid.');
} finally { fs.closeSync(tempFd); fs.closeSync(bankFd); }
`;

async function bankOperation(bank: Awaited<ReturnType<typeof bundleDirectory>>, input: Record<string, unknown>) {
  await assertBank(bank);
  await withWorktreeMaterializationExecution(bank.directory, bank.identity, () => materializationAwareExecFile(
    process.execPath, ['-e', BANK_OPERATION, JSON.stringify(input)],
    { cwd: bank.directory, env: gitEnvironment(), timeout: 120_000, maxBuffer: 1024 * 1024 },
  ));
  await assertBank(bank);
}

/** Prove all source objects in an empty repository before publishing its bank receipt. */
export async function preserveWorkspaceGitBundle(snapshot: WorkspaceSnapshotRecord, repositoryPath: string): Promise<WorkspaceGitBundleReceipt> {
  if (!snapshot.recoveryRef.startsWith('refs/o8/recovery/')) throw new Error('Portable source needs a protected recovery ref.');
  const repositoryIdentity = await captureWorktreeMaterializationIdentity(repositoryPath);
  const sourceValues = async () => {
    const ref = await gitValue(repositoryPath, repositoryIdentity, ['rev-parse', '--verify', snapshot.recoveryRef + '^{commit}']);
    const tree = await gitValue(repositoryPath, repositoryIdentity, ['rev-parse', '--verify', snapshot.recoveryRef + '^{tree}']);
    if (ref !== snapshot.headCommit || tree !== snapshot.treeSha) throw new Error('The protected Git source changed before portable preservation.');
    return {
      objectFormat: await gitValue(repositoryPath, repositoryIdentity, ['rev-parse', '--show-object-format']),
      commitCount: Number(await gitValue(repositoryPath, repositoryIdentity, ['rev-list', '--count', snapshot.recoveryRef])),
      objectCount: (await gitValue(repositoryPath, repositoryIdentity, ['rev-list', '--objects', '--no-object-names', snapshot.recoveryRef])).split('\n').length,
    };
  };
  const expected = await sourceValues();
  if (expected.objectFormat !== 'sha1' && expected.objectFormat !== 'sha256') throw new Error('Git object format is unsupported.');
  const bank = await bundleDirectory();
  const bankFd = await open(bank.directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  let preparation: string;
  try {
    const captured = await bankFd.stat();
    if (captured.dev !== bank.identity.device || captured.ino !== bank.identity.inode) {
      throw new Error('Private bundle preparation lost its captured bank owner.');
    }
    const capturedName = await mkdtemp(path.join(descriptorPath(bankFd.fd), '.prepare-'));
    preparation = path.join(bank.directory, path.basename(capturedName));
    await assertBank(bank);
  } finally { await bankFd.close(); }
  const identity = await privateDirectory(preparation);
  const leaf = path.basename(preparation);
  try {
    await assertBank(bank);
    await createBundle(snapshot, repositoryPath, repositoryIdentity, preparation, identity);
    const before = await readBundleFile(path.join(preparation, 'source.bundle'));
    await gitValue(preparation, identity, ['init', '--bare', '--template=', '--object-format=' + expected.objectFormat, 'verify.git']);
    // Empty-repository verification refuses every prerequisite, alternate, or missing parent object.
    await gitValue(preparation, identity, ['--git-dir=verify.git', 'bundle', 'verify', 'source.bundle']);
    await gitValue(preparation, identity, ['--git-dir=verify.git', 'fetch', '--no-tags', '--no-recurse-submodules',
      './source.bundle', snapshot.recoveryRef + ':refs/heads/recovered']);
    await gitValue(preparation, identity, ['--git-dir=verify.git', 'fsck', '--full', '--strict']);
    const recovered = {
      headCommit: await gitValue(preparation, identity, ['--git-dir=verify.git', 'rev-parse', 'refs/heads/recovered^{commit}']),
      treeSha: await gitValue(preparation, identity, ['--git-dir=verify.git', 'rev-parse', 'refs/heads/recovered^{tree}']),
      commitCount: Number(await gitValue(preparation, identity, ['--git-dir=verify.git', 'rev-list', '--count', 'refs/heads/recovered'])),
      objectCount: (await gitValue(preparation, identity, ['--git-dir=verify.git', 'rev-list', '--objects', '--no-object-names', 'refs/heads/recovered'])).split('\n').length,
    };
    const after = await readBundleFile(path.join(preparation, 'source.bundle'));
    const repeated = await sourceValues();
    if (before.sha256 !== after.sha256 || !sameFile(before.stat, after.stat)
      || recovered.headCommit !== snapshot.headCommit || recovered.treeSha !== snapshot.treeSha
      || recovered.commitCount !== expected.commitCount || recovered.objectCount !== expected.objectCount
      || JSON.stringify(expected) !== JSON.stringify(repeated)) {
      throw new Error('Independent Git recovery did not prove the exact source and its required objects.');
    }
    const receipt: WorkspaceGitBundleReceipt = {
      schema: 'o8/workspace-git-bundle/v1', sha256: after.sha256, bytes: after.content.length,
      objectFormat: expected.objectFormat, repositoryUuid: snapshot.repositoryUuid, packetId: snapshot.packetId,
      snapshotGeneration: snapshot.snapshotGeneration, snapshotFingerprint: snapshot.snapshotFingerprint,
      headCommit: snapshot.headCommit, treeSha: snapshot.treeSha, recoveryRef: snapshot.recoveryRef,
      prerequisiteCount: 0, commitCount: expected.commitCount, objectCount: expected.objectCount,
    };
    await bankOperation(bank, { operation: 'publish', leaf, identity, sha256: receipt.sha256,
      file: { device: after.stat.dev, inode: after.stat.ino } });
    await readWorkspaceGitBundle(receipt);
    return receipt;
  } finally {
    await bankOperation(bank, { operation: 'remove', leaf, identity });
  }
}
