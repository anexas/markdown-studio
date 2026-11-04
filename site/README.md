# Landing page

A single self-contained `index.html` — no build step, no JavaScript, no external assets, so it
can be uploaded to Cloudflare Pages exactly as it is.

## Deploying

Either connect this `site` directory as the Pages project's build output with no build command,
or upload it directly:

```bash
npx wrangler pages deploy site --project-name markdown-studio
```

Then point `markdownstudio.saxenas.uk` at the Pages project under **Custom domains**.

## The download link

The button points at the GitHub release asset by a stable name, so it keeps working across
versions without editing the page:

```
https://github.com/anexas/markdown-studio/releases/latest/download/Markdown-Studio-x64.msi
```

For that to resolve, the attached asset must be named exactly `Markdown-Studio-x64.msi` — no
version in the filename. Upload the MSI from `releases/` under that name when creating a release.

The repository is public and `v0.5.3` carries the asset under that name, so the link works
today. Keep the name identical on future releases — `releases/latest` resolves to the newest
release, but only if the asset it contains is still called `Markdown-Studio-x64.msi`.
Replace the GitHub URLs in the page if the repository ever moves.
