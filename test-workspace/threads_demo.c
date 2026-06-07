/*
 * threads_demo.c  —  Debug Inspector test program
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

/* ---------------- Dynamic array (void* buffer + size -> 'cast' gerekir) ---------------- */
typedef struct {
    int          x;
    int          y;
    const char  *label;
} widget_t;

typedef struct {
    void *data;   /* generic buffer; aslinda widget_t[] tutar */
    int   size;   /* eleman sayisi */
} dyn_array_t;

/* ---------------- Index-linked list (dizi + index 'next'; bazi gozler bos) ---------------- */
typedef struct {
    int          id;
    const char  *name;
    int          next;   /* sonraki elemanin index'i; -1 = son */
} slot_t;

/* ---------------- Process (master: alt listeleri tutar) ---------------- */
typedef struct process {
    int              pid;
    const char      *name;
    tcb_t           *thread_list;   /* bu process'in thread'leri */
    ksem_t          *sem_list;      /* bu process'in semaphore'lari */
    kmutex_t        *mutex_list;    /* bu process'in mutex'leri */
    int              slot_head;     /* bu process'in g_slot_pool icindeki index-zinciri basi */
    struct process  *next;
} process_t;

/* ---------------- Timer (array-mode ornegi: g_timers[count]) ---------------- */
typedef struct {
    int          id;
    const char  *name;
    int          period;
    int          elapsed;
    int          active;
} ktimer_t;

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
#define MAX_TIMERS  8
ktimer_t g_timers[MAX_TIMERS];
int      g_timer_count = 0;
#define MAX_PROCS   4
process_t g_procs[MAX_PROCS];
int       g_proc_count = 0;
process_t *g_process_list;   /* master listenin başı */
#define MAX_WIDGETS 4
widget_t    g_widget_pool[MAX_WIDGETS];   /* arka depo */
dyn_array_t g_widgets;                    /* data = void*, widget_t[] gösterir */
void       *g_slots[3];                   /* void* pointer dizisi -> her biri widget_t* (wrap örneği) */
#define MAX_SLOTS 6
slot_t      g_slot_pool[MAX_SLOTS];        /* bazi gozler bos; index ile bagli */
int         g_slot_head;                   /* zincirin ilk index'i */

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

static void mk_timer(int id, const char *name, int period, int elapsed, int active)
{
    ktimer_t *t = &g_timers[g_timer_count++];
    t->id = id; t->name = name; t->period = period; t->elapsed = elapsed; t->active = active;
}

static process_t *mk_proc(int pid, const char *name, tcb_t *threads, ksem_t *sems, kmutex_t *mutexes)
{
    process_t *p = &g_procs[g_proc_count++];
    p->pid = pid; p->name = name;
    p->thread_list = threads; p->sem_list = sems; p->mutex_list = mutexes;
    p->next = NULL;
    return p;
}

/* Breakpoint'i buraya koy. printf yerine gozlemlenebilir bir yan etki. */
static volatile unsigned g_sink;
static void inspect_point(int tick)
{
    g_sink = (unsigned)(tick + g_thread_count + g_sem_count + g_mutex_count + g_timer_count);
}

int main(void)
{
    tcb_t *a = mk_thread(1, "main",     RUNNING, 0);
    tcb_t *b = mk_thread(2, "worker-1", READY,   5);
    tcb_t *c = mk_thread(3, "worker-2", BLOCKED, 5);
    tcb_t *d = mk_thread(4, "logger",   WAITING, 9);
    a->next = b; b->next = NULL;     /* init process'in thread'leri */
    c->next = d; d->next = NULL;     /* worker process'in thread'leri */

    ksem_t *s0 = mk_sem(1, 0, 1, 2, FIFO);
    ksem_t *s1 = mk_sem(2, 3, 5, 0, PRIORITY);
    ksem_t *s2 = mk_sem(3, 1, 1, 0, FIFO);
    s0->next = s1; s1->next = NULL;  /* init */
    s2->next = NULL;                 /* worker */

    kmutex_t *m0 = mk_mutex(1, "bus_lock", 1, 1, 1);
    kmutex_t *m1 = mk_mutex(2, "log_lock", 0, 0, 0);
    m0->next = NULL;                 /* init */
    m1->next = NULL;                 /* worker */

    mk_timer(1, "tick",     10,  3, 1);
    mk_timer(2, "watchdog", 100, 50, 1);
    mk_timer(3, "blink",    5,   0, 0);

    /* dynamic array: void* buffer widget_t[] tutar; erişim için cast gerekir */
    g_widget_pool[0].x = 10; g_widget_pool[0].y = 20; g_widget_pool[0].label = "button";
    g_widget_pool[1].x = 30; g_widget_pool[1].y = 40; g_widget_pool[1].label = "slider";
    g_widget_pool[2].x = 50; g_widget_pool[2].y = 60; g_widget_pool[2].label = "label";
    g_widgets.data = g_widget_pool;
    g_widgets.size = 3;
    /* void* pointer dizisi: her eleman bir widget_t*; erişim için wrap ile cast gerekir */
    g_slots[0] = &g_widget_pool[0];
    g_slots[1] = &g_widget_pool[1];
    g_slots[2] = &g_widget_pool[2];

    /* index-linked havuz; iki ayri zincir (gozler index ile bagli) */
    g_slot_pool[0].id = 101; g_slot_pool[0].name = "alpha"; g_slot_pool[0].next = 2;
    g_slot_pool[2].id = 102; g_slot_pool[2].name = "beta";  g_slot_pool[2].next = 5;
    g_slot_pool[5].id = 103; g_slot_pool[5].name = "gamma"; g_slot_pool[5].next = -1;
    g_slot_head = 0;                 /* global zincir: 0 -> 2 -> 5 */
    g_slot_pool[1].id = 201; g_slot_pool[1].name = "w-a";   g_slot_pool[1].next = 3;
    g_slot_pool[3].id = 202; g_slot_pool[3].name = "w-b";   g_slot_pool[3].next = -1;
    /* goz 4 bos kalir */

    /* master liste: 2 process, her biri kendi alt listeleriyle */
    process_t *p0 = mk_proc(1, "init",   a, s0, m0);
    process_t *p1 = mk_proc(2, "worker", c, s2, m1);
    p0->slot_head = 0;   /* init  : 0 -> 2 -> 5  (alpha, beta, gamma) */
    p1->slot_head = 1;   /* worker: 1 -> 3       (w-a, w-b) */
    p0->next = p1; p1->next = NULL;
    g_process_list = p0;

    /* eski pool kökü de geçerli kalsın */
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
        g_timers[0].elapsed = tick;          /* array eleman alanı her tick değişir */
        g_widget_pool[0].x  = 10 + tick;     /* void* array elemanı da değişir */
        inspect_point(tick);
    }
    return 0;
}
