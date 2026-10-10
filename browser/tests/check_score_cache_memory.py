"""Eviction must preserve AP results when revisiting an evicted signature."""
from pathlib import Path
import sys, inspect, copy
sys.path.insert(0,str(Path(__file__).parent))
from baseline import load_baseline
p=load_baseline(Path(sys.argv[1]))
d=p.Data();req=p.demo_profile();m=req['candidate_member_ids'];s=req['candidate_snap_ids']
slots=p.sk.derive_ap_skill_contract(d.snapshot,req['profile'],m,s,_verified_inputs=d.skill_inputs)['slots']
original=p.Scores
source=inspect.getsource(original).replace('if len(self.cache) >= 512:','if len(self.cache) >= 16:')
exec(source,p.__dict__)
spec={'song_id':100109,'difficulty':'easy','method':'ap'}
old=original(d,spec,False);new=p.Scores(d,spec,False)
for i in range(18):
    variant=copy.deepcopy(slots);variant[0]['extension_ms']+=i*10
    assert old.evaluate(100000,variant)==new.evaluate(100000,variant)
    assert len(new.cache)<=16
new.score_cache.clear()
assert old.evaluate(100000,slots)==new.evaluate(100000,slots)
assert len(new.cache)<=16
print('PASS 18 AP signatures and revisited evicted input match unchanged scorer; cache <=16')
