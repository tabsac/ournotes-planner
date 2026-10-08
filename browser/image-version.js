// Use validated image content hashes so a cached placeholder cannot hide new art.
(() => {
  let files = {};
  const version = value => {
    const url = new URL(value, location.href);
    if (url.origin !== location.origin) return value;
    const name = url.pathname.replace(/^\//, '');
    if (!files[name]) return value;
    url.searchParams.set('v', files[name].slice(0, 16));
    return url.href;
  };
  window.PlannerImageUrl = version;
  function update(img) {
    const src = img.getAttribute('src');
    if (!src) return;
    const next = version(src);
    if (new URL(src, location.href).href !== new URL(next, location.href).href) img.src = next;
  }
  // Includes off-DOM images used for exported B25 / activity canvases.
  const original = Object.getOwnPropertyDescriptor(HTMLImageElement.prototype, 'src');
  Object.defineProperty(HTMLImageElement.prototype, 'src', {...original, set(value) { original.set.call(this, version(value)); }});
  fetch('./image-manifest.json', {cache: 'no-store'}).then(r => {
    if (!r.ok) throw Error('Image manifest unavailable');
    return r.json();
  }).then(manifest => {
    files = manifest.files || {};
    document.querySelectorAll('img').forEach(update);
    new MutationObserver(records => {
      for (const record of records) {
        if (record.type === 'attributes') update(record.target);
        for (const node of record.addedNodes || []) {
          if (node.nodeType !== 1) continue;
          if (node.matches('img')) update(node);
          node.querySelectorAll('img').forEach(update);
        }
      }
    }).observe(document.documentElement, {subtree:true,childList:true,attributes:true,attributeFilter:['src']});
  }).catch(error => console.warn(error.message));
})();
