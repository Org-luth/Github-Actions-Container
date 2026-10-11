import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import MarkdownIt from 'markdown-it';

const root = new URL('../', import.meta.url);
const source = readFileSync(new URL('README.md', root), 'utf8');
const english = source.split('## English\n')[1]?.split('## Deutsch\n')[0];
const german = source.split('## Deutsch\n')[1];
if (!english || !german) {
  throw new Error('README must contain English and Deutsch sections');
}
const markdown = new MarkdownIt({ html: false, linkify: true });
const output = new URL('docs/_site/', root);
mkdirSync(output, { recursive: true });
copyFileSync(new URL('docs/style.css', root), new URL('style.css', output));
copyFileSync(new URL('docs/pipeline.svg', root), new URL('pipeline.svg', output));
writeFileSync(new URL('index.html', output), `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="description" content="Linux and Windows GitHub Actions runner containers: setup, releases and registry publishing. English and German documentation.">
  <title>GitHub Actions Runner Containers</title>
  <link rel="stylesheet" href="style.css">
</head>
<body>
  <a class="skip-link" href="#english">Skip to documentation</a>
  <header>
    <a class="brand" href="#">Org-luth / Runner Containers</a>
    <nav aria-label="Documentation navigation">
      <a href="#english" lang="en">English</a>
      <a href="#deutsch" lang="de">Deutsch</a>
      <a href="https://github.com/Org-luth/Github-Actions-Container">GitHub</a>
    </nav>
  </header>
  <main>
    <div class="title-row">
      <p class="eyebrow">OPERATIONS / SELF-HOSTED RUNNERS</p>
      <h1>GitHub Actions Runner Containers</h1>
      <p>Ubuntu 24.04 &amp; Windows Server Core LTSC 2022 &middot; x64</p>
    </div>
    <figure>
      <img src="pipeline.svg" width="960" height="180" alt="Conventional commits on main produce a semantic release, followed by parallel Linux and Windows builds published to Docker Hub and a private registry.">
    </figure>
    <section id="english" lang="en" aria-labelledby="english-title">
      <h2 id="english-title">English</h2>
      ${markdown.render(english)}
    </section>
    <section id="deutsch" lang="de" aria-labelledby="deutsch-title">
      <h2 id="deutsch-title">Deutsch</h2>
      ${markdown.render(german)}
    </section>
  </main>
  <footer>Org-luth &middot; <a href="https://github.com/Org-luth/Github-Actions-Container/releases">Release history</a></footer>
</body>
</html>\n`);
console.log('Documentation built in docs/_site');