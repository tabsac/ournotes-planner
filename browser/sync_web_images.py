"""Keep local build images aligned with the server's validated public image manifest."""
import hashlib, json, pathlib, urllib.request

def sync(here):
    base='https://on.tabsac.com/'
    with urllib.request.urlopen(base+'image-manifest.json',timeout=30) as response:
        manifest=json.load(response)
    for name,h in manifest['files'].items():
        parts=pathlib.PurePosixPath(name).parts
        if len(parts)!=2 or parts[0] not in ('card-images','jacket-images') or '..' in parts or not parts[1].endswith('.webp'):
            raise ValueError('Invalid public image path')
        folder='card' if parts[0]=='card-images' else 'jacket'
        target=here/'static-images'/folder/parts[1]
        if target.exists() and hashlib.sha256(target.read_bytes()).hexdigest()==h: continue
        with urllib.request.urlopen(base+name,timeout=30) as response: data=response.read()
        if hashlib.sha256(data).hexdigest()!=h: raise ValueError('Public image digest mismatch: '+name)
        target.parent.mkdir(parents=True,exist_ok=True)
        temporary=target.with_name(target.name+'.sync-tmp'); temporary.write_bytes(data); temporary.replace(target)
    (here/'image-manifest.json').write_text(json.dumps(manifest,sort_keys=True),encoding='utf-8')
    print('Public image sync: %d validated images'%len(manifest['files']))

if __name__=='__main__': sync(pathlib.Path(__file__).resolve().parent)
