"""Scheduled, validated frontend rebuild from the server's decoded game data."""
from pathlib import Path
import hashlib,json,os,subprocess,sys,time,shutil
ROOT=Path(__file__).resolve().parents[1];LIVE=Path('/www/wwwroot/ournotes-web');INCOMING=Path('/opt/ournotes-web-builder/incoming')
def run(*args):subprocess.run(args,cwd=ROOT,check=True)
def sha(p):return hashlib.sha256(p.read_bytes()).hexdigest()
master=json.loads((INCOMING/'master_index.json').read_text());version=json.loads((INCOMING/'version.json').read_text())
assert master['contentVersion'] and version['counts']['charts']==version['counts']['songs']*4
# A version may contain a future event: reevaluate the current event every run.
sys.path.insert(0,str(ROOT/'browser'));from snapshot_release import current_event
event=current_event(json.loads((INCOMING/'master/MasterEvent.json').read_text())['_allData'])['_id']
source_hash=hashlib.sha256(b''.join(p.read_bytes() for p in sorted((ROOT/'browser').glob('*')) if p.suffix in ['.py','.js','.css'] and p.name not in ['generated-app.js','activity-model.js','image-version.js','style.css']) + b''.join((ROOT/'tools'/name).read_bytes() for name in ['auto_publish_frontend.py','sync_decoded_master.py','validate_snapshot_release.py'])).hexdigest()
fingerprint=hashlib.sha256(json.dumps({'master':master['resourceVersion'],'data':version.get('contentDigests'),'event':event,'source':source_hash},sort_keys=True).encode()).hexdigest()
receipt=ROOT/'last-published.json'
if receipt.exists() and json.loads(receipt.read_text())['fingerprint']==fingerprint:
    print('Frontend game data already current');sys.exit(0)
baseline=sha(LIVE/'index.html')
run(sys.executable,'-B','tools/sync_decoded_master.py',str(INCOMING))
run(sys.executable,'-B','tools/sync_charts_from_data.py','--write','--base','http://127.0.0.1:8080')
run(sys.executable,'-B','browser/build_browser.py','--build')
run(sys.executable,'-B','tools/validate_snapshot_release.py')
site=ROOT/'browser/dist';assert '<meta name="ournotes-api-base" content="">' in (site/'index.html').read_text('utf-8');assert sha(LIVE/'index.html')==baseline,'Concurrent frontend release; leave live files untouched'
files=sorted(p for p in site.rglob('*') if p.is_file())
changes=[p for p in files if not (LIVE/p.relative_to(site)).is_file() or sha(p)!=sha(LIVE/p.relative_to(site))]
backup=Path('/var/backups/ournotes-auto-frontend')/time.strftime('%Y%m%dT%H%M%SZ',time.gmtime());backup.mkdir(parents=True)
# Keep old hashed resources for existing tabs; publish index only after new resources.
for src in sorted(changes,key=lambda p:p.relative_to(site).as_posix()=='index.html'):
    relative=src.relative_to(site);dst=LIVE/relative
    if dst.exists():saved=backup/relative;saved.parent.mkdir(parents=True,exist_ok=True);shutil.copy2(dst,saved)
    dst.parent.mkdir(parents=True,exist_ok=True);temp=dst.with_name(dst.name+'.auto-next');shutil.copyfile(src,temp);os.chmod(temp,0o644);os.replace(temp,dst)
    assert sha(dst)==sha(src)
receipt.write_text(json.dumps({'fingerprint':fingerprint,'event':event,'index':sha(LIVE/'index.html'),'publishedAt':time.time()}))
print('Frontend published:',len(changes),'files, event',event)
