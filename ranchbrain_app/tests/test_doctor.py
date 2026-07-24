from ranchbrain.doctor import run_doctor

def test_doctor_runs():
    code = run_doctor()
    assert code in (0, 1)
