import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import YAML from 'yaml';

const require = createRequire(import.meta.url);
const root = new URL('../', import.meta.url);
const read = path => readFileSync(new URL(path, root), 'utf8');
const workflow = name => YAML.parse(read(`.github/workflows/${name}.yml`));
const powerShell = process.env.PWSH_PATH || 'pwsh';
const powerShellAvailable = spawnSync(powerShell, ['-NoLogo', '-NoProfile', '-Command', 'exit 0']).status === 0;

test('both images declare luth2 as owner and OCI author', () => {
  for (const file of ['Dockerfile.linux', 'Dockerfile.windows']) {
    const content = read(file);
    assert(content.includes('LABEL owner="luth2"'));
    assert(content.includes('org.opencontainers.image.authors="luth2 (https://github.com/luth2)"'));
  }
});

test('workflow YAML is valid and has explicit permissions', () => {
  for (const file of readdirSync(new URL('.github/workflows/', root))) {
    const document = YAML.parseDocument(read(`.github/workflows/${file}`), { uniqueKeys: true });
    assert.deepEqual(document.errors, [], file);
    assert(document.toJS().permissions, file);
  }
});

test('semantic-release produces conventional major, minor and patch releases', async () => {
  const release = require('../release.config.cjs');
  const { analyzeCommits } = await import('@semantic-release/commit-analyzer');
  const logger = { log() {} };
  for (const [message, expected] of [
    ['fix(deps): update Actions Runner to 2.338.0', 'patch'],
    ['feat: add runner images', 'minor'],
    ['feat!: change runner configuration\n\nBREAKING CHANGE: RUNNER_URL is now required', 'major'],
    ['docs: clarify setup', null],
    ['chore(deps): update actions/checkout', null],
  ]) {
    assert.equal(await analyzeCommits({}, { commits: [{ message }], logger }), expected, message);
  }
  assert.deepEqual(release.branches, ['main']);
  assert.equal(release.tagFormat, 'v${version}');
  assert(!release.plugins.includes('@semantic-release/npm'));
});

test('release output supports retries without republishing old or draft releases', async () => {
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
  const source = read('scripts/release.mjs').replace(/^import .*;\n/gm, '');
  const execute = new AsyncFunction('semanticRelease', 'appendFileSync', 'execFileSync', 'fetch', 'process', 'console', source);
  async function run({ result = false, tags = '', latest = tags, release = { draft: false, prerelease: false } } = {}) {
    const outputs = [];
    await execute(
      async () => result,
      (file, content) => outputs.push(content),
      (command, args) => args.includes('--points-at') ? tags : latest,
      async (url, options) => {
        assert.equal(url, 'https://api.github.com/repos/Org-luth/Github-Actions-Container/releases/tags/v1.0.0');
        assert.equal(options.headers.Authorization, 'Bearer test-only');
        return { ok: true, json: async () => release };
      },
      { env: { GITHUB_REPOSITORY: 'Org-luth/Github-Actions-Container', GITHUB_TOKEN: 'test-only', GITHUB_OUTPUT: 'mock-output' } },
      { log() {} },
    );
    return outputs;
  }
  assert.deepEqual(await run({ result: { nextRelease: { version: '1.0.0' } } }), ['version=1.0.0\n']);
  assert.deepEqual(await run(), ['version=\n']);
  assert.deepEqual(await run({ tags: 'v1.0.0' }), ['version=1.0.0\n']);
  await assert.rejects(run({ tags: 'v1.0.0', latest: 'v1.1.0\nv1.0.0' }), /older release/);
  await assert.rejects(run({ tags: 'v1.0.0\nv1.1.0' }), /Multiple release tags/);
  await assert.rejects(run({ tags: 'v1.0.0', release: { draft: true } }), /published stable/);
});

test('release uses installation-token Git authentication rather than PAT authentication', async () => {
  const config = workflow('release');
  const environment = config.jobs.release.steps.find(step => step.id === 'semantic').env;
  assert.equal(environment.GITHUB_TOKEN, '${{ secrets.GITHUB_TOKEN }}');
  assert(!('GH_TOKEN' in environment));
  assert.equal(config.jobs.release.permissions.contents, 'write');

  const source = read('node_modules/semantic-release/lib/get-git-auth-url.js')
    .replace(/^import .*;\n/gm, '')
    .replace('export default async (context) => {', 'return async (context) => {');
  const { format, parse } = await import('node:url');
  const getAuthUrl = new Function('format', 'parse', 'isNil', 'hostedGitInfo', 'debugAuthUrl', 'verifyAuth', source)(
    format, parse, value => value == null, { fromUrl: () => null }, () => () => {},
    async () => { throw new Error('No persisted checkout credentials'); },
  );
  const authUrl = await getAuthUrl({
    cwd: '.',
    env: { GITHUB_ACTION: 'semantic', GITHUB_TOKEN: 'test-only' },
    branch: { name: 'main' },
    options: { repositoryUrl: 'https://github.com/Org-luth/Github-Actions-Container.git' },
  });
  const parsed = new URL(authUrl);
  assert.equal(parsed.username, 'x-access-token');
  assert.equal(parsed.password, 'test-only');
});

test('build matrix uses native Linux and Windows engines and publishes only released versions', () => {
  const config = workflow('release');
  assert.deepEqual(config.jobs.build.needs, ['check', 'release']);
  assert.deepEqual(config.jobs.build.strategy.matrix.include.map(item => [item.variant, item.runner, item.os]), [
    ['ubuntu24.04', 'ubuntu-latest', 'linux'],
    ['windows', 'windows-2022', 'windows'],
  ]);
  assert(config.jobs.release.if.includes("github.ref == 'refs/heads/main'"));
  for (const step of config.jobs.build.steps.filter(step => /Login|Publish|Prepare registry/.test(step.name || ''))) {
    assert.equal(step.if, "needs.release.outputs.version != ''");
  }
  const text = read('.github/workflows/release.yml');
  for (const secret of ['PAT_DOCKERHUB', 'USER_DOCKERHUB', 'PW_AZURECONTAINERREG', 'USER_AZURECONTAINERREG', 'URL_AZURECONTAINERREG']) {
    assert(text.includes(`secrets.${secret}`), secret);
  }
  assert(text.includes('latest-$env:VARIANT'));
  assert(!text.includes('docker/build-push-action'));
});

test('all PR sources assign luth2 and the privileged workflow does not checkout PR code', () => {
  const assignment = workflow('assign-pr');
  assert(assignment.on.pull_request_target);
  assert(!assignment.jobs.assign.steps.some(step => step.uses?.startsWith('actions/checkout')));
  assert(assignment.jobs.assign.steps[0].with.script.includes("assignees: ['luth2']"));
  const dependabot = YAML.parse(read('.github/dependabot.yml'));
  assert(dependabot.updates.some(update => update['package-ecosystem'] === 'github-actions'));
  for (const update of dependabot.updates) assert.deepEqual(update.assignees, ['luth2']);
  const update = workflow('update-runner').jobs.update.steps.at(-1).with;
  assert.equal(update.assignees, 'luth2');
  assert(update.title.startsWith('fix(deps):'));
});

test('runner update validates both assets before writing and is idempotent', async () => {
  const script = workflow('update-runner').jobs.update.steps.find(step => step.id === 'runner').with.script;
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
  const execute = new AsyncFunction('require', 'github', 'core', script);
  const original = Object.fromEntries(['Dockerfile.linux', 'Dockerfile.windows'].map(file => [file, read(file)]));
  const release = {
    tag_name: 'v99.0.0', draft: false, prerelease: false,
    assets: [
      { name: 'actions-runner-linux-x64-99.0.0.tar.gz', state: 'uploaded', digest: `sha256:${'a'.repeat(64)}` },
      { name: 'actions-runner-win-x64-99.0.0.zip', state: 'uploaded', digest: `sha256:${'b'.repeat(64)}` },
    ],
  };
  const files = { ...original };
  const writes = [];
  const fakeFs = {
    readFileSync: file => files[file],
    writeFileSync: (file, content) => { writes.push(file); files[file] = content; },
  };
  const core = { info() {}, setOutput() {} };
  const run = data => execute(() => fakeFs, { rest: { repos: { getLatestRelease: async () => ({ data }) } } }, core);
  await assert.rejects(run({ ...release, assets: release.assets.slice(0, 1) }), /Missing asset/);
  assert.equal(writes.length, 0);
  await assert.rejects(run({ ...release, prerelease: true }), /stable runner/);
  await assert.rejects(run({ ...release, assets: release.assets.map(asset => ({ ...asset, digest: null })) }), /SHA256/);
  await run(release);
  assert.equal(writes.length, 2);
  for (const file of Object.keys(files)) {
    assert(files[file].includes('ARG RUNNER_VERSION=99.0.0'));
    assert.equal(files[file].replace(/^ARG RUNNER_(VERSION|SHA256)=.*$/gm, ''), original[file].replace(/^ARG RUNNER_(VERSION|SHA256)=.*$/gm, ''));
  }
  await run(release);
  assert.equal(writes.length, 2);
  await assert.rejects(run({ ...release, tag_name: 'v98.0.0', assets: release.assets.map(asset => ({ ...asset, name: asset.name.replace('99.0.0', '98.0.0') })) }), /downgrade/);
  assert.equal(writes.length, 2);
});

test('Linux startup requires URL, token and runner name', { skip: process.platform === 'win32' }, () => {
  const command = JSON.parse(read('Dockerfile.linux').split('\n').find(line => line.startsWith('CMD ')).slice(4)).at(-1);
  assert.equal(spawnSync('bash', ['-n', '-c', command]).status, 0);
  for (const missing of ['RUNNER_URL', 'RUNNER_TOKEN', 'RUNNER_NAME']) {
    const environment = { PATH: process.env.PATH, RUNNER_URL: 'https://github.com/example', RUNNER_TOKEN: 'test-only', RUNNER_NAME: 'test-runner' };
    delete environment[missing];
    const result = spawnSync('bash', ['-c', command], { env: environment, encoding: 'utf8' });
    assert.notEqual(result.status, 0);
    assert(result.stderr.includes(`Set ${missing}`));
  }
});

test('PowerShell build commands and Windows startup parse correctly', { skip: !powerShellAvailable }, () => {
  const scripts = workflow('release').jobs.build.steps.filter(step => step.run).map(step => step.run);
  const dockerfile = read('Dockerfile.windows');
  const command = JSON.parse(dockerfile.split('\n').find(line => line.startsWith('CMD ')).slice(4)).at(-1);
  scripts.push(command);
  scripts.push(dockerfile.match(/\nRUN ([\s\S]*?)\n\nUSER/)[1].replace(/`\r?\n\s*/g, ' '));
  for (const script of scripts) {
    const result = spawnSync(powerShell, ['-NoLogo', '-NoProfile', '-Command',
      '$tokens = $null; $parseErrors = $null; [void][System.Management.Automation.Language.Parser]::ParseInput($env:SCRIPT_TO_CHECK, [ref]$tokens, [ref]$parseErrors); if ($parseErrors.Count) { $parseErrors | Out-String | Write-Error; exit 1 }'],
    { env: { ...process.env, SCRIPT_TO_CHECK: script }, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
  }
  for (const missing of ['RUNNER_URL', 'RUNNER_TOKEN', 'RUNNER_NAME']) {
    const environment = { ...process.env, RUNNER_URL: 'https://github.com/example', RUNNER_TOKEN: 'test-only', RUNNER_NAME: 'test-runner' };
    delete environment[missing];
    const result = spawnSync(powerShell, ['-NoLogo', '-NoProfile', '-Command', command], { env: environment, encoding: 'utf8' });
    assert.notEqual(result.status, 0);
    assert(result.stderr.includes(`Set ${missing}`));
  }
});