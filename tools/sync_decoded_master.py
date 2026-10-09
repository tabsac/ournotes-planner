"""Consume decoded public master tables copied from the existing server updater."""
from pathlib import Path
import argparse,json,hashlib
ROOT=Path(__file__).resolve().parents[1]
p=argparse.ArgumentParser();p.add_argument('input',type=Path);a=p.parse_args()
b=ROOT/'browser';index=json.loads((b/'snapshot-override/index.json').read_text('utf-8'));remote=json.loads((a.input/'master_index.json').read_text('utf-8'))
raw=b/'snapshot-override'/index['snapshot_prefix'];raw.mkdir(parents=True,exist_ok=True)
manifest_path=raw.parent/'source_manifest.json';manifest=json.loads(manifest_path.read_text('utf-8'))
for name in index['tables']:
    data=(a.input/'master'/f'{name}.json').read_bytes();table=json.loads(data)
    data=json.dumps(table,ensure_ascii=False,indent=1).encode('utf-8')
    assert isinstance(table.get('_allData'),list),name
    ids=[r['_id'] for r in table['_allData']];assert len(ids)==len(set(ids)),name
    (raw/f'{name}.json').write_bytes(data)
    index['tables'][name]=remote['files'][name+'.bin']
    for entry in manifest['files']:
        if entry['local_path']==f'raw/{name}.json':
            entry['sha256']=hashlib.sha256(data).hexdigest()
            entry['bytes']=len(data)
            entry['row_count']=len(table['_allData'])
            if 'git_blob_sha' in entry:entry['git_blob_sha']=hashlib.sha1(b'blob %d\0'%len(data)+data).hexdigest()
index['version']=remote['resourceVersion'];index['content_version']=remote['contentVersion']
(b/'snapshot-override/index.json').write_text(json.dumps(index,ensure_ascii=False,indent=2),encoding='utf-8',newline='\n')
manifest_path.write_text(json.dumps(manifest,ensure_ascii=False,indent=2),encoding='utf-8',newline='\n')
print('Decoded public master snapshot synchronized:',index['content_version'])
