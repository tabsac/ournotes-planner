from pathlib import Path
import sys,json,hashlib,time
import tempfile,zipfile
BROWSER=Path(__file__).resolve().parents[1]/'browser'
DEST=Path(sys.argv[1] if len(sys.argv)>1 else '.').resolve();DEST.mkdir(parents=True,exist_ok=True)
CORE=Path(tempfile.mkdtemp(prefix='ournotes-activity-fixture-'))
with zipfile.ZipFile(BROWSER/'public/planner-runtime.zip') as z:z.extractall(CORE)
sys.path.insert(0,str(CORE))
import planner_core as p
d=p.Data();cat=d.catalog();req=p.demo_profile();req['name']='活动组卡验收示例（合成养成）';req['candidate_member_ids']=[59,11,55,26,3];req['candidate_snap_ids']=[33,37,52,61,3]
for k,key in [('members','candidate_member_ids'),('snaps','candidate_snap_ids')]:
 cards={c['id']:c for c in cat[k]}
 req['profile']['inventory'][k]=[dict(id=i,level=min(20,cards[i]['caps'][0]),**({'training_count':0,'awakening_count':0,'live_skill_level':1,'gekisou_skill_level':1} if k=='members' else {'limit_break_count':0})) for i in req[key]]
req['profile']['character_ranks']=[{'character_id':c['id'],'rank':10} for c in cat['characters']]
req['profile']['character_total_rank']=len(cat['characters'])*10;req['profile']['tgw_card_rank']=1
req['profile']['facilities']=[{'id':c['id'],'level':0} for c in cat['facilities']]
for mode in ['normal','challenge']:req['settings'][mode]['sheets']=[{'song_id':100109,'difficulty':'expert'}]
print(p.growth_issues(req,d),flush=True)
r=p.optimize(req,data=d)
model=json.loads((BROWSER/'public/build-info.json').read_text('utf8'))['activity_model']
finger=hashlib.sha256(json.dumps({'model':model,'inputs':req},sort_keys=True,separators=(',',':'),ensure_ascii=False).encode()).hexdigest()
for k in ['members','snaps']:
 for c in cat[k]:c['thumbnail']=c['thumbnail'].lstrip('/')
a={'kind':'activity','schema_version':1,'model':model,'fingerprint':finger,'savedAt':'2026-10-07T00:00:00Z','computedAt':'2026-10-07T00:00:00Z','actual_inputs':req,'result':r,'display':{'members':[c for c in cat['members'] if c['id'] in req['candidate_member_ids']],'snaps':[c for c in cat['snaps'] if c['id'] in req['candidate_snap_ids']],'songs':[{'id':c['id'],'title':c['title']} for c in cat['songs']]}}
(DEST/'activity-synthetic.json').write_text(json.dumps(a,ensure_ascii=False),'utf8');print('PASS genuine solver result',r['plans']['event_pt']['totals'],flush=True)

import shutil
assert CORE.resolve().parent == Path(tempfile.gettempdir()).resolve() and CORE.name.startswith('ournotes-activity-fixture-')
shutil.rmtree(CORE.resolve())
