import { appendFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import semanticRelease from 'semantic-release';

const result = await semanticRelease();
let version = result ? result.nextRelease.version : '';

if (!version) {
  const tags = execFileSync('git', ['tag', '--points-at', 'HEAD'], { encoding: 'utf8' })
    .trim().split('\n').filter(tag => /^v\d+\.\d+\.\d+$/.test(tag));
  if (tags.length > 1) {
    throw new Error('Multiple release tags point to HEAD; refusing ambiguous image publication');
  }
  if (tags.length === 1) {
    const latestTag = execFileSync('git', ['tag', '--list', 'v*', '--sort=-v:refname'], { encoding: 'utf8' })
      .trim().split('\n').find(tag => /^v\d+\.\d+\.\d+$/.test(tag));
    if (latestTag !== tags[0]) {
      throw new Error('Refusing to republish an older release as latest');
    }
    const repository = process.env.GITHUB_REPOSITORY;
    if (!/^[\w.-]+\/[\w.-]+$/.test(repository || '')) {
      throw new Error('GITHUB_REPOSITORY is required to verify an existing release');
    }
    const response = await fetch(`https://api.github.com/repos/${repository}/releases/tags/${tags[0]}`, {
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${process.env.GH_TOKEN}`,
        'X-GitHub-Api-Version': '2022-11-28',
      },
    });
    if (!response.ok) {
      throw new Error(`Could not verify the existing GitHub release: HTTP ${response.status}`);
    }
    const release = await response.json();
    if (release.draft || release.prerelease) {
      throw new Error('Image publication requires a published stable GitHub release');
    }
    version = tags[0].slice(1);
    console.log(`Reusing release ${tags[0]} for the current commit`);
  }
}

if (version && !/^\d+\.\d+\.\d+$/.test(version)) {
  throw new Error('Invalid release version');
}
if (process.env.GITHUB_OUTPUT) {
  appendFileSync(process.env.GITHUB_OUTPUT, `version=${version}\n`);
}
console.log(version ? `Image version: ${version}` : 'No release required; image publication skipped');