## Why

<!--
  A reviewer can infer the diff. They cannot infer the motivation, and without
  it they cannot tell whether the change is scoped correctly. This is the most
  valuable part of the PR.
-->

## What changed

<!-- Split unrelated changes. A refactor and a behaviour change are two PRs. -->

## Behaviour a caller would notice

<!--
  Breaking or observable changes only. A caller reading only the diff will not
  spot a changed default, a removed event, or a new failure mode.
  Breaking changes also belong in CHANGELOG.md.
-->

- [ ] No caller-visible change
- [ ] Yes — described above, and CHANGELOG.md updated

## Type of change

- [ ] Bug fix
- [ ] New feature
- [ ] Performance
- [ ] Refactor (no behaviour change)
- [ ] Documentation
- [ ] Build / CI / tooling

## How this was verified

<!--
  "Tested" is not an answer. "Load tested at 2000 calls" or "verified by
  installing the packed tarball" is. Say what you ran and what you saw.
-->

- [ ] `npm run typecheck`
- [ ] `npm run lint`
- [ ] `npm run build`
- [ ] `npm test`
- [ ] `npm run loadtest` (if the per-call path changed)
- [ ] Installed the packed tarball into a clean project (if public API changed)

## Checklist

- [ ] Tests fail without my change, and pass with it
- [ ] New code follows [`agents/agents.md`](../agents/agents.md); new rules
      learned are recorded there
- [ ] Documentation describes only behaviour the code actually has
- [ ] Every outbound request has a deadline; every per-call buffer is bounded
- [ ] A promise created at a fire-and-forget call site is handled
- [ ] No new runtime dependency, or the reason is explained below

**New runtime dependency:** <!-- required if you added one -->

```
<!-- Why an existing dependency or a few lines could not do it. -->
```
