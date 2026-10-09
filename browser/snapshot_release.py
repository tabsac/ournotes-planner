"""Build current event and native solver data from one verified snapshot."""
from datetime import datetime
from zoneinfo import ZoneInfo
from pathlib import Path
import hashlib,json,zipfile

def current_event(events):
    now=datetime.now(ZoneInfo('Asia/Shanghai')).strftime('%Y/%m/%d %H:%M:%S')
    eligible=[e for e in events if e['_startAt']<=now]
    if not eligible: raise ValueError('No started event in snapshot')
    return max(eligible,key=lambda e:(e['_startAt'],e['_id']))

def normalize_events(here,read_table):
    idx=json.loads((here/'snapshot-override/index.json').read_text('utf-8'))
    root=here/'snapshot-override'/Path(idx['snapshot_prefix']).parent
    raw=root/'raw';out=root/'normalized';out.mkdir(parents=True,exist_ok=True)
    tables={n:read_table(raw,n) for n in ['MasterEvent','MasterLiveEventPoint','MasterLiveEventReward','MasterLiveChallengePoint','MasterChallengeLiveEventPoint','MasterChallengeLiveEventReward','MasterLiveMusicBoostBonus','MasterChallengeMusicBoostBonus','MasterChallengeMusic','MasterEventEffect']}
    for event in tables['MasterEvent']:
        value={'schema_version':1,'event_id':event['_id'],'name_text_id':event['_nameTextId'],'shop_currency_item_id':event['_eventItemId']}
        for challenge in [False,True]:
            prefix='MasterChallengeLive' if challenge else 'MasterLive'
            group=event['_challengeLiveEventPointGroup' if challenge else '_liveEventPointGroup']
            reward_group=event['_challengeLiveEventRewardGroup' if challenge else '_liveEventRewardGroup']
            rows=[]
            for code,rank in enumerate(['D','C','B','A','S','SS'],2):
                points=[p for p in tables[prefix+'EventPoint'] if p['_group']==group and p['_scoreRank']==code]
                rewards=[p for p in tables[prefix+'EventReward'] if p['_eventGroup']==reward_group and p['_scoreRank']==code]
                assert len(points)==1 and rewards
                assert all(p['_resourceId']==event['_eventItemId'] and p['_probability']==10000 for p in rewards)
                row={'rank':rank,'rank_code':code,'event_pt_base':points[0]['_value'],'shop_pt_base_guaranteed':sum(p['_resourceCount'] for p in rewards),'shop_reward_rows':rewards}
                if not challenge:
                    cp=[p for p in tables['MasterLiveChallengePoint'] if p['_scoreRank']==code];assert len(cp)==1
                    row['cp_base']=cp[0]['_value']
                rows.append(row)
            value['challenge_base_rewards' if challenge else 'ordinary_base_rewards']=rows
        value['ordinary_boost_rows_raw']=tables['MasterLiveMusicBoostBonus']
        value['challenge_cp_consumption_rows_raw']=tables['MasterChallengeMusicBoostBonus']
        value['challenge_music_rows_raw']=[p for p in tables['MasterChallengeMusic'] if p['_eventId']==event['_id']]
        value['bonus_effects_raw']=[p for p in tables['MasterEventEffect'] if p['_eventId']==event['_id']]
        (out/f"event_{event['_id']}.json").write_text(json.dumps(value,ensure_ascii=False,indent=2),encoding='utf-8',newline='\n')
        if event['_id']==current_event(tables['MasterEvent'])['_id']:
            (out/'current_event.json').write_text(json.dumps(value,ensure_ascii=False,indent=2),encoding='utf-8',newline='\n')

def export_native(here,runtime):
    master={};charts=[]
    with zipfile.ZipFile(runtime) as z:
        for n in z.namelist():
            if '/raw/' in n and n.endswith('.json'):
                rows=json.loads(z.read(n)).get('_allData')
                if not isinstance(rows,list):continue
                cols=list(dict.fromkeys(k for row in rows for k in row))
                master[Path(n).stem]={'columns':cols,'rows':[[r.get(c) for c in cols] for r in rows]}
            elif '/normalized/converted_charts/' in n and n.endswith('.json'):charts.append(json.loads(z.read(n)))
    index=json.loads((here/'snapshot-override/index.json').read_text('utf-8'))
    data={'format':'nnnotes.deck-data/1','provenance':{'source':'current-web-runtime','sha256':hashlib.sha256(runtime.read_bytes()).hexdigest(),'resourceVersion':index['version'],'contentVersion':index['content_version']},'master':master,'charts':sorted(charts,key=lambda d:d['scoreId'])}
    target=here/'deck-native-assets/deck-data.json'
    target.write_text(json.dumps(data,ensure_ascii=False,separators=(',',':')),encoding='utf-8',newline='\n')
