"""First-party extensions: a real leader constraint and uniform-order score statistics."""
import copy, itertools, statistics
_locked = None

def configure(request, p, data):
    global _locked
    value=request.get('settings',{}).get('fixed_leader_id')
    _locked=None
    if value is not None:
        if type(value) is not int or value<=0:
            raise p.InputError('固定队长请选择有效的成员卡。')
        mids=p._select_ids(request,request['profile'],'candidate_member_ids','members')
        if value not in mids:
            raise p.InputError('固定队长不在本次候选卡池中，请勾选该卡参与搜索，或取消固定队长。')
        _locked=value
    request=copy.deepcopy(request)
    # Included in all sheet cache keys, preventing reuse of unconstrained proofs.
    request['profile']['_fixed_leader_id']=_locked
    return request

def install(p, ss):
    model_init=p.PowerModel.__init__
    best=p.PowerModel.best_leader
    def init(self,data,profile,mids,sids):
        model_init(self,data,profile,mids,sids)
        self.fixed_leader=profile.get('_fixed_leader_id')
    def leader(self,mids):
        mid=self.fixed_leader
        if mid is None:return best(self,mids)
        if mid not in mids:raise p.InputError('所选队伍不包含固定队长。')
        cards=[self.cards[m] for m in mids]; chars=[self.chars[m] for m in mids]
        rates=p.leader_rates(self.data,self.cards[mid],self.own[mid],cards,chars,self.music_type)
        return mid,[p.dp._mul_floor(self.b[m],rate) for m,rate in zip(mids,rates)]
    p.PowerModel.__init__=init;p.PowerModel.best_leader=leader
    teams_init=p.MemberTeams.__init__; iterate=p.MemberTeams.iter_from
    def team_init(self,grouped):
        teams_init(self,grouped);self.fixed_leader=_locked
        if _locked is not None:
            fixed_char=self.character[_locked];counts=[1,0,0,0,0]
            for char,cards in grouped.items():
                if char==fixed_char:continue
                for k in range(4,0,-1):counts[k]+=counts[k-1]*len(cards)
            self.count=counts[4]
    def team_iter(self,offset):
        if self.fixed_leader is None:return iterate(self,offset)
        return itertools.islice((team for team in iterate(self,0) if self.fixed_leader in team),offset,None)
    p.MemberTeams.__init__=team_init;p.MemberTeams.iter_from=team_iter
    phase=ss.Search.add_phase
    def add_phase(self,mode):
        zone=phase(self,mode)
        if self.model.fixed_leader is not None:
            self.base.add(zone['leader'][self.model.fixed_leader]==1)
        return zone
    ss.Search.add_phase=add_phase
    evaluate=p.Scores.evaluate
    def score(self,power,slots=None):
        result=evaluate(self,power,slots)
        if 'average_score' in result:return result
        if self.method=='skip': values=[result['minimum_score']]
        else:
            chart=self.chart
            def point(sig):
                pct,base,factor=sig
                return p.ms.note_score(power,chart['level'],chart['denominator'],chart['adjustment'],pct,chart['perfect_percent'],base,factor)
            points={}
            def cached(sig):
                if sig not in points:points[sig]=point(sig)
                return points[sig]
            values=[sum(n*cached(sig) for sig,n in counts) for counts in self.signatures(slots)]
        # Identical skill slots each contribute the same factorial multiplicity.
        # Therefore unique slot sequences are uniformly weighted over all 120 orders.
        result['average_score']=sum(values)/len(values)
        result['median_score']=statistics.median(values)
        result['order_rank_counts']={rank:sum(p.ms.rank_for_score(v,self.chart['rank_thresholds'])==rank for v in values)*result['skill_orders']//len(values) for rank in p.RANKS}
        return result
    p.Scores.evaluate=score
