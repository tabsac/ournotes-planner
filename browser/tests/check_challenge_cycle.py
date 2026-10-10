"""Regression: a lower direct payout can win once earned CP is spent in challenges."""
import importlib.util,copy
from pathlib import Path
spec=importlib.util.spec_from_file_location('deck_fast',Path(__file__).resolve().parents[1]/'deck_fast.py');m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
best={'target_value':1000,'consumed':200,'member_ids':[1,2,3,4,5],'snap_ids':[1,2,3,4,5]}
low_cp={'per_live':{'event_pt':100,'cp':20}}
high_cp={'per_live':{'event_pt':90,'cp':40}}
m.augment_exchange_row(low_cp,best,'event_pt',4);m.augment_exchange_row(high_cp,best,'event_pt',4)
assert high_cp['target_value']==290 and low_cp['target_value']==200
original=copy.deepcopy(high_cp);m.augment_exchange_row(high_cp,best,'event_pt',4);assert original==high_cp
assert high_cp['challenge_team'] is not best and high_cp['per_live']['event_pt']==90
print('PASS CP exchange changes ranking; direct reward retained; repeated formatting does not double count')
