from __future__ import annotations

import logging
import signal

from forge3d.pipeline import PipelineRunner
from forge3d.settings import Settings
from forge3d.store import JobStore

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("forge3d.worker")
running = True


def _stop(_signum: int, _frame: object) -> None:
    global running
    running = False


def main() -> None:
    signal.signal(signal.SIGTERM, _stop)
    signal.signal(signal.SIGINT, _stop)
    settings = Settings.from_env()
    settings.ensure_directories()
    store = JobStore(settings)
    runner = PipelineRunner(settings, store)
    log.info(
        "worker started pool=%s queues=%s dry_run=%s",
        settings.worker_pool or "legacy",
        ",".join(settings.worker_queues),
        settings.dry_run,
    )
    while running:
        item = store.dequeue(timeout=5)
        if not item:
            continue
        source_queue, job_id = item
        try:
            job = store.load(job_id)
            resource_class = settings.resource_class_for(job.asset_kind.value)
            if settings.worker_pool and resource_class != settings.worker_pool:
                destination = settings.queue_for_asset_kind(job.asset_kind.value)
                store.enqueue(job_id, destination)
                log.warning(
                    "job rerouted job_id=%s source=%s destination=%s kind=%s",
                    job_id,
                    source_queue,
                    destination,
                    job.asset_kind.value,
                )
                continue
            runner.run(job)
            log.info("job finished job_id=%s", job_id)
        except Exception:
            log.exception("job failed job_id=%s", job_id)


if __name__ == "__main__":
    main()
