/*
 * threads_demo.c  —  RTOS Inspector test program
 * Standart kutuphane KULLANMAZ: include satiri yok, printf/malloc vb. yok.
 * Tum veriler statik global'lerde; pthread degil, kendi TCB/semaphore
 * yapilarimiz var. Listeye karmasik bir root uzerinden erisilir:
 *   g_kernel.pools[0]->thread_list
 */

#define NULL ((void *)0)

/* ---------------- Thread ---------------- */
typedef enum { RUNNING, READY, BLOCKED, WAITING } thread_state_t;

typedef struct tcb {
    int             id;
    const char     *name;
    thread_state_t  state;
    int             prio;
    void           *stack_base;   /* stack start */
    unsigned long   stack_size;   /* bytes */
    struct tcb     *next;
} tcb_t;

/* ---------------- Semaphore ---------------- */
typedef enum { FIFO, PRIORITY } sem_discipline_t;

typedef struct ksem {
    int               id;
    int               count;
    int               max_count;
    int               waiting;
    sem_discipline_t  discipline;
    struct ksem      *next;
} ksem_t;

/* ---------------- Mutex ---------------- */
typedef struct kmutex {
    int             id;
    const char     *name;
    int             owner;     /* owning thread id, 0 = free */
    int             locked;    /* 0 / 1 */
    int             waiters;
    struct kmutex  *next;
} kmutex_t;

/* ---------------- Kernel / pool (karmasik root icin) ---------------- */
typedef struct kpool {
    tcb_t    *thread_list;
    ksem_t   *sem_list;
    kmutex_t *mutex_list;
} kpool_t;

typedef struct {
    kpool_t *pools[2];
} kernel_t;

/* ---- global'ler ---- */
#define MAX_THREADS 8
#define MAX_SEMS    8
#define MAX_MUTEXES 8
tcb_t    g_threads[MAX_THREADS];
int      g_thread_count = 0;
ksem_t   g_sems[MAX_SEMS];
int      g_sem_count = 0;
kmutex_t g_mutexes[MAX_MUTEXES];
int      g_mutex_count = 0;

kpool_t  g_pool0;
kernel_t g_kernel;

static tcb_t *mk_thread(int id, const char *name, thread_state_t st, int prio)
{
    tcb_t *t = &g_threads[g_thread_count++];
    t->id = id; t->name = name; t->state = st; t->prio = prio;
    t->stack_base = (void *)(unsigned long long)(0x7000000ULL + (unsigned long long)id * 0x10000ULL);
    t->stack_size = 0x4000UL; /* 16 KB */
    t->next = NULL;
    return t;
}

static ksem_t *mk_sem(int id, int count, int max, int waiting, sem_discipline_t d)
{
    ksem_t *s = &g_sems[g_sem_count++];
    s->id = id; s->count = count; s->max_count = max;
    s->waiting = waiting; s->discipline = d; s->next = NULL;
    return s;
}

static kmutex_t *mk_mutex(int id, const char *name, int owner, int locked, int waiters)
{
    kmutex_t *m = &g_mutexes[g_mutex_count++];
    m->id = id; m->name = name; m->owner = owner;
    m->locked = locked; m->waiters = waiters; m->next = NULL;
    return m;
}

/* Breakpoint'i buraya koy. printf yerine gozlemlenebilir bir yan etki. */
static volatile unsigned g_sink;
static void inspect_point(int tick)
{
    g_sink = (unsigned)(tick + g_thread_count + g_sem_count + g_mutex_count);
}

int main(void)
{
    tcb_t *a = mk_thread(1, "main",     RUNNING, 0);
    tcb_t *b = mk_thread(2, "worker-1", READY,   5);
    tcb_t *c = mk_thread(3, "worker-2", BLOCKED, 5);
    tcb_t *d = mk_thread(4, "logger",   WAITING, 9);
    a->next = b; b->next = c; c->next = d; d->next = NULL;

    ksem_t *s0 = mk_sem(1, 0, 1, 2, FIFO);
    ksem_t *s1 = mk_sem(2, 3, 5, 0, PRIORITY);
    ksem_t *s2 = mk_sem(3, 1, 1, 0, FIFO);
    s0->next = s1; s1->next = s2; s2->next = NULL;

    kmutex_t *m0 = mk_mutex(1, "bus_lock", 1, 1, 1);
    kmutex_t *m1 = mk_mutex(2, "log_lock", 0, 0, 0);
    m0->next = m1; m1->next = NULL;

    g_pool0.thread_list = a;
    g_pool0.sem_list    = s0;
    g_pool0.mutex_list  = m0;
    g_kernel.pools[0]   = &g_pool0;
    g_kernel.pools[1]   = NULL;

    for (int tick = 0; tick < 3; tick++) {
        b->state   = (tick % 2) ? RUNNING : READY;
        c->state   = (tick % 2) ? BLOCKED : WAITING;
        m1->locked = (tick % 2);
        m1->owner  = (tick % 2) ? 4 : 0;
        inspect_point(tick);
    }
    return 0;
}
