import ast
import unittest
from pathlib import Path


def load_action_aliases() -> dict[str, str]:
    source = Path(__file__).with_name("blender").joinpath("retarget.py")
    tree = ast.parse(source.read_text(encoding="utf-8"))
    for node in tree.body:
        if isinstance(node, ast.Assign) and any(
            isinstance(target, ast.Name) and target.id == "ACTION_ALIASES"
            for target in node.targets
        ):
            return ast.literal_eval(node.value)
    raise AssertionError("ACTION_ALIASES not found")


class RetargetActionTests(unittest.TestCase):
    def test_action_aliases_include_story_poses(self) -> None:
        aliases = load_action_aliases()
        self.assertEqual(aliases["Sitting_Idle_Loop"], "sit_loop")
        self.assertEqual(aliases["Crouch_Idle_Loop"], "crouch_idle_loop")
        self.assertEqual(aliases["Interact"], "interact")


if __name__ == "__main__":
    unittest.main()
