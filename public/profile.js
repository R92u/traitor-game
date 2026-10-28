/* Persistent data belongs to this browser, not to a server account. */
const BrowserProfile = (() => {
  const key = 'spy_profile_v1';
  const classes = ['default', 'gambler', 'fortune_teller', 'mellstroy'];
  function normalize(value) {
    const data = value && typeof value === 'object' ? value : {};
    const inventory = [...new Set(['default', ...(Array.isArray(data.inventory) ? data.inventory.filter(id => classes.includes(id)) : [])])];
    return {
      username: typeof data.username === 'string' ? data.username.trim().slice(0,20) : '',
      coins: Number.isSafeInteger(data.coins) && data.coins >= 0 ? data.coins : 0,
      inventory,
      equippedClass: inventory.includes(data.equippedClass) ? data.equippedClass : 'default',
    };
  }
  function load(fallback) {
    try {
      const saved = localStorage.getItem(key);
      return normalize(saved ? JSON.parse(saved) : fallback);
    } catch { return normalize(fallback); }
  }
  function save(profile) {
    try {
      localStorage.setItem(key, JSON.stringify(normalize(profile)));
      localStorage.removeItem('spy_token');
      return true;
    } catch { return false; }
  }
  return {key, load, save};
})();
