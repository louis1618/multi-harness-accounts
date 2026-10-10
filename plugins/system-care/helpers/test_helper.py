import importlib.util, pathlib, sys, unittest
from unittest.mock import patch, Mock
path=pathlib.Path(__file__).parent/'system-care-helper.py'
spec=importlib.util.spec_from_file_location('care_helper',path);helper=importlib.util.module_from_spec(spec);spec.loader.exec_module(helper)
class Check(unittest.TestCase):
 def test_allowlist(self):
  self.assertEqual(set(helper.ACTIONS),{'apt-autoclean','journal-vacuum'})
  for action in ['rm','volume-remove','/etc/passwd','apt-autoclean;rm -rf /']:
   with self.assertRaises(ValueError):helper.command(action)
  self.assertNotIn('autoremove',helper.command('apt-autoclean'))
  self.assertEqual(helper.command('journal-vacuum'),['/usr/bin/journalctl','--vacuum-time=30d'])
 def test_no_root_no_commands(self):
  with patch.object(sys,'argv',['helper','apt-autoclean']),patch.object(helper.os,'geteuid',return_value=1000),patch.object(helper.subprocess,'run')as run:
   self.assertEqual(helper.main(),3);run.assert_not_called()
 def test_fixed_environment_and_arguments(self):
  with patch.object(sys,'argv',['helper','journal-vacuum']),patch.object(helper.os,'geteuid',return_value=0),patch.object(helper.subprocess,'run',return_value=Mock(returncode=0))as run:
   self.assertEqual(helper.main(),0)
   self.assertEqual(run.call_args.args[0],['/usr/bin/journalctl','--vacuum-time=30d'])
   env=run.call_args.kwargs['env'];self.assertEqual(env['HOME'],'/root');self.assertNotIn('APT_CONFIG',env);self.assertNotIn('PYTHONPATH',env)
if __name__=='__main__':unittest.main()
