from pathlib import Path
import importlib.util,json,copy,tempfile,shutil
root=Path(__file__).resolve().parents[1]
spec=importlib.util.spec_from_file_location('check',root/'tools/check_plan.py');m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
current_document=json.loads((root/'execution.json').read_text());results=[]
# Negative test fixtures must be independent of live project approvals.
doc=copy.deepcopy(current_document)
for step in doc['steps']:
 step.update(status='NOT_STARTED',evidence=None,reviewed_revision=None,review_result=None,reviewer=None)
def run(name,fn):fn();results.append(name)
def ok():
 assert not m.validate(root,current_document)
 assert not m.validate(root,doc)
run('Valid baseline',ok)
def negative(name,mut):
 d=copy.deepcopy(doc);mut(d);assert m.validate(root,d),name
 results.append(name)
negative('Duplicate step rejected',lambda d:d['steps'][1].update(id='01.01'))
negative('Skipped predecessor rejected',lambda d:d['steps'][4].update(depends_on=['01.01']))
negative('Unknown status rejected',lambda d:d['steps'][0].update(status='DONE'))
negative('Approval without evidence rejected',lambda d:d['steps'][0].update(status='APPROVED'))
negative('Future technical input rejected',lambda d:d['steps'][0].update(technical_inputs=['24']))
negative('Active work without approved prerequisite rejected',lambda d:d['steps'][1].update(status='IN_PROGRESS'))
negative('Missing prompt rejected',lambda d:d['steps'][0].update(prompt='does-not-exist.md'))
negative('Missing acceptance rejected',lambda d:d['steps'][0].update(acceptance=''))
def invalidation():
 d=copy.deepcopy(doc);d['steps'][0]['status']='APPROVED';d['steps'][1]['status']='IN_REVIEW';m.invalidate(d,'01.01');assert d['steps'][0]['status']==d['steps'][1]['status']=='STALE';assert d['steps'][2]['status']=='NOT_STARTED'
run('Downstream invalidation preserves unstarted work',invalidation)
def unknown():
 try:m.invalidate(copy.deepcopy(doc),'99.99')
 except ValueError:return
 raise AssertionError()
run('Unknown invalidation ID rejected',unknown)
def derived():
 with tempfile.TemporaryDirectory() as tmp:
  p=Path(tmp);(p/'state').mkdir();m.sync(p,doc);assert len((p/'TRACKER.csv').read_text().splitlines())==121;assert '01.01' in (p/'state/CURRENT.md').read_text()
run('Tracker and current generated consistently',derived)
def unique():
 cases=[s['acceptance'] for s in doc['steps'] if s['kind']!='REVIEW'];assert len(cases)==len(set(cases))==96
run('96 distinct acceptance scenarios',unique)
def review_missing():
 d=copy.deepcopy(doc);d['steps'][0].update(status='APPROVED',evidence='README.md',reviewed_revision='synthetic-test-revision');assert m.validate(root,d)
run('Approval missing reviewer/result rejected',review_missing)
def complete_approval():
 d=copy.deepcopy(doc);d['steps'][0].update(status='APPROVED',evidence='README.md',reviewed_revision='synthetic-test-revision',review_result='PASS',reviewer='synthetic validator test');assert not m.validate(root,d)
run('Complete synthetic approval accepted structurally',complete_approval)
print('\n'.join('PASS '+x for x in results))
