"""Patch an existing web API without changing authentication or stored results."""
import argparse
from pathlib import Path


def patch(source):
    if 'def result_payload_limit(' in source:
        if source.count('> result_payload_limit(payload)') != 2:
            raise ValueError('Unexpected existing result limit implementation')
        return source
    anchor='MAX_PAYLOAD = 256 * 1024'
    if source.count(anchor)!=1:raise ValueError('Unexpected base limit')
    source=source.replace(anchor,anchor+'\nMAX_DECK_PAYLOAD = 2 * 1024 * 1024')
    helper="""def result_payload_limit(payload):
    if (isinstance(payload, dict) and payload.get("kind") == "deck-batch"
            and type(payload.get("schema_version")) is int and payload["schema_version"] == 1
            and isinstance(payload.get("sections"), list) and isinstance(payload.get("display"), dict)):
        return MAX_DECK_PAYLOAD
    return MAX_PAYLOAD


"""
    source=source.replace('def compact(value):',helper+'def compact(value):')
    old='if len(blob.encode("utf-8")) > MAX_PAYLOAD:'
    if source.count(old)!=2:raise ValueError('Unexpected create/update result guards')
    source=source.replace(old,'if len(blob.encode("utf-8")) > result_payload_limit(payload):')
    source=source.replace('"单条上限 256 KB"','"单条上限 %d KB" % (result_payload_limit(payload) // 1024)')
    compile(source,'planner_api.py','exec')
    return source


if __name__=='__main__':
    parser=argparse.ArgumentParser();parser.add_argument('--source',required=True);parser.add_argument('--output',required=True);args=parser.parse_args()
    Path(args.output).write_text(patch(Path(args.source).read_text(encoding='utf-8')),encoding='utf-8')
