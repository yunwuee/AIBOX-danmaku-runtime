export function isHongguoPlayerUrl() { return false; }

export default class DisabledHongguoSource {
  async search() { return []; }
  async handleAnimes() { return []; }
  async getEpisodes() { return []; }
  async getEpisodeDanmu() { return []; }
  async getComments() { return []; }
  formatComments() { return []; }
}
