from pathlib import Path
import sys,copy,itertools,statistics,json
here=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(here/'tests'))
from baseline import load_baseline
p=load_baseline(Path(sys.argv[1]) if len(sys.argv)>1 else here/'test-output/team-options')
sys.path.insert(0,str(here));import team_options,solver_search as ss
team_options.install(p,ss)
d=p.Data();req=p.demo_profile();lock=req['candidate_member_ids'][1]
req['settings']['fixed_leader_id']=lock
r=team_options.configure(req,p,d)
groups={i:[10*i,10*i+1] for i in range(1,7)}
team_options._locked=11;t=p.MemberTeams(groups);expected=[x for x in itertools.combinations(range(10,72),5) if all(xi in t.character for xi in x) and 11 in x and len({t.character[xi] for xi in x})==5] if False else None
allteams=list(t);assert len(allteams)==len(t)==80
assert all(11 in x and len({t.character[i] for i in x})==5 for x in allteams)
assert list(t.iter_from(37))==allteams[37:]
team_options.configure(req,p,d)
mids=req['candidate_member_ids'];sids=req['candidate_snap_ids']
model=p.PowerModel(d,r['profile'],mids,sids)
song=d.catalog()['songs'][0]['id']
model.music(song,False);assert model.best_leader(mids)[0]==lock
bad=copy.deepcopy(req);bad['settings']['fixed_leader_id']=999999
try:team_options.configure(bad,p,d);raise AssertionError('Excluded leader accepted')
except p.InputError:pass
sc=p.Scores(d,{'song_id':song,'difficulty':'expert','method':'ap'},False)
slots=p.sk.derive_ap_skill_contract(d.snapshot,req['profile'],mids,sids,_verified_inputs=d.skill_inputs)['slots']
for label,testslots in [('native',slots),('duplicate', [slots[0],slots[0],slots[2],slots[2],slots[4]])]:
 power=100000;out=sc.evaluate(power,testslots);ch=sc.chart
 vals=[]
 for order in itertools.permutations(range(5)):
  vals.append(sum(n*p.ms.note_score(power,ch['level'],ch['denominator'],ch['adjustment'],pct,ch['perfect_percent'],base,factor) for (pct,base,factor),n in sc.order_signature(testslots,order)))
 assert out['average_score']==sum(vals)/120
 assert out['median_score']==statistics.median(vals)
 assert sum(out['order_rank_counts'].values())==120
 assert out['order_rank_counts']=={rank:sum(p.ms.rank_for_score(v,ch['rank_thresholds'])==rank for v in vals) for rank in p.RANKS}
print('PASS: fixed leader, 80 legal teams, resume offset, excluded leader, and full 120-order statistics including duplicates')

req=p.demo_profile();req['settings']['fixed_leader_id']=11
for mode in ('normal','challenge'):
 req['settings'][mode]['method']='ap';req['settings'][mode]['sheets']=[{'song_id':100109,'difficulty':'expert'}]
ss.should_use_solver=lambda *a:False
r=team_options.configure(req,p,d);brute=p.optimize(r,data=d)
ss.should_use_solver=lambda *a:True
solver=p.optimize(r,data=d)
for out in (brute,solver):
 for obj in ('event_pt','shop_pt'):
  for mode in ('normal','challenge'):
   for plan in out['top3'][obj][mode]:assert plan[mode]['leader_member_id']==11
for obj in ('event_pt','shop_pt'):
 assert brute['top3'][obj]['normal'][0]['normal']['power']==solver['top3'][obj]['normal'][0]['normal']['power']
print('PASS: exhaustive and CP solver both respect locked leader in normal/challenge')

