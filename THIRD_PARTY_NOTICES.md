# Third-party notices

This runtime contains a mechanically selected and modified subset of [huangxd-/danmu_api](https://github.com/huangxd-/danmu_api) at commit `22ba26ae82a11d3416a5b76490cd6f8ff29c397e`.

The upstream project is distributed under the GNU Affero General Public License v3.0. The corresponding selected source is committed under `generated/upstream/`; the deterministic selection rules live in `config/runtime-policy.json` and `scripts/sync-upstream.mjs`.

AIBOX-specific changes disable the standalone server, management APIs, Redis integrations, the local forward proxy, unsupported sources, and WASM-dependent Migu support.
