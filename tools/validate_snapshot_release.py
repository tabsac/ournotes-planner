"""Validate a complete release before switching its entry page."""
from pathlib import Path
import hashlib,json,tempfile,zipfile,sys
root=Path(__file__).resolve().parents[1];site=root/'browser/dist'
info=json.loads((site/'build-info.json').read_text('utf-8'));runtime=site/'planner-runtime.zip'
assert hashlib.sha256(runtime.read_bytes()).hexdigest()==info['runtime_sha256']
native=json.loads((site/'deck-local'/info['local_deck_engine']/'deck-data.json').read_text('utf-8'))
assert native['provenance']['sha256']==info['runtime_sha256']
with tempfile.TemporaryDirectory() as temp:
    with zipfile.ZipFile(runtime) as z:z.extractall(temp)
    sys.path.insert(0,temp)
    import planner_core
    data=planner_core.Data(Path(temp)/'research/2026-10-01');cat=data.catalog()
    allowed={c['_liveMusicId'] for c in data.tables['MasterChallengeMusic'] if c['_eventId']==data.event['event_id']}
    assert {s['id'] for s in cat['songs'] if s['challenge']}==allowed
    selected=[];characters=set()
    for card in cat['members']:
        cid=card['character_ids'][0]
        if cid not in characters:characters.add(cid);selected.append(card['id'])
        if len(selected)==5:break
    snaps=[s['id'] for s in cat['snaps'][:5]]
    profile={'inventory':{'members':[{'id':i,'level':1,'training_count':0,'awakening_count':0,'live_skill_level':1,'gekisou_skill_level':1} for i in selected],'snaps':[{'id':i,'level':1,'limit_break_count':0} for i in snaps]},'facilities':[{'id':f['id'],'level':0} for f in cat['facilities']],'character_ranks':[{'character_id':c['id'],'rank':1} for c in cat['characters']],'character_total_rank':len(cat['characters']),'tgw_card_rank':1}
    power=planner_core.PowerModel(data,profile,selected,snaps)
    for sid in allowed:
        planner_core._song_specs({'challenge':{'sheets':[{'song_id':sid,'difficulty':'easy'}],'method':'skip'}},'challenge',data)
        planner_core.Scores(data,{'song_id':sid,'difficulty':'easy','method':'skip'},True)
        power.music(sid,True)

    assert len(cat['songs'])*4==len(native['charts'])
    assert data.event['event_id']==json.loads((site/'static-data/snapshot-digest.json').read_text('utf-8'))['event']['id']
    print('Verified current event',data.event['event_id'],'songs',len(cat['songs']),'charts',len(native['charts']))
assert 'data-tab="evidence"' not in (site/'index.html').read_text('utf-8')
