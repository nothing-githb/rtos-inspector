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
    unsigned long   stack_size;   /* toplam (bytes) */
    unsigned long   stack_used;   /* kullanilan (bytes) -> usage bar */
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
    char         tag[8];  /* sabit boyutlu char dizisi: GDB sondaki \000'lari da basar */
    int          next;   /* sonraki elemanin index'i; -1 = son */
} slot_t;

/* ---------------- Box: her goz bir sarmalayici; asil veri 'data' field'inda (cast oncesi field hop) ---------------- */
typedef struct {
    void *data;   /* asil veri (widget_t*); cast'ten ONCE bu field ile erisilir */
    int   kind;
} box_t;

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

/* binary search tree (tree mode demo): kok + left/right cocuk pointer'lari */
typedef struct bnode {
    int key;
    char label[8];
    struct bnode *left, *right;
} bnode_t;

/* ---- global'ler (YÜZLERCE satır: ana tablolar döngülerle üretilir) ---- */
#define N_PROC      8                  /* master process sayisi */
#define TPP         32                 /* thread / process -> 256 thread */
#define SPP         24                 /* sem / process    -> 192 sem */
#define SLOT_BLK    32                 /* slot / process   -> 256 slot */
#define MAX_THREADS (N_PROC * TPP)
#define MAX_SEMS    (N_PROC * SPP)
#define MAX_MUTEXES 200
#define MAX_TIMERS  300
#define MAX_WIDGETS 256
#define MAX_PROCS   N_PROC
#define MAX_SLOTS   (N_PROC * SLOT_BLK)

tcb_t    g_threads[MAX_THREADS];
int      g_thread_count = 0;
ksem_t   g_sems[MAX_SEMS];
int      g_sem_count = 0;
kmutex_t g_mutexes[MAX_MUTEXES];
int      g_mutex_count = 0;
ktimer_t g_timers[MAX_TIMERS];
int      g_timer_count = 0;
process_t g_procs[MAX_PROCS];
int       g_proc_count = 0;
process_t *g_process_list;                /* master listenin başı */
widget_t    g_widget_pool[MAX_WIDGETS];   /* arka depo (cast dizisi) */
dyn_array_t g_widgets;                    /* data = void*, widget_t[] gösterir */
void       *g_slots[3];                   /* void* pointer dizisi -> her biri widget_t* (wrap örneği) */
box_t       g_boxes[3];                    /* her goz {void *data; int kind}; data widget_t* (cast oncesi field hop) */
slot_t      g_slot_pool[MAX_SLOTS];        /* index ile bagli; process basina bir blok */
int         g_slot_head;                   /* global zincirin ilk index'i */
kpool_t  g_pool0;
kernel_t g_kernel;
bnode_t  g_bnodes[16];
int      g_bnode_count = 0;
bnode_t *g_tree_root;                      /* binary search tree (tree mode demo) */

/* libc yok -> isimler literal havuzundan döngüsel seçilir */
static const char *NAMES[]  = { "main","worker","logger","net","disk","audio","video","sensor","timer","gc","ui","ipc" };
#define NN  ((int)(sizeof(NAMES)/sizeof(NAMES[0])))
static const char *PNAMES[] = { "init","worker","netd","diskd","audiod","videod","sensord","gcd","uid","ipcd","logd","kbd" };
#define NPN ((int)(sizeof(PNAMES)/sizeof(PNAMES[0])))

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

static void set_tag(char *dst, const char *src)  /* mini strcpy (max 7 char) */
{
    int i = 0;
    while (src[i] && i < 7) { dst[i] = src[i]; i++; }
    dst[i] = 0;
}

static process_t *mk_proc(int pid, const char *name, tcb_t *threads, ksem_t *sems, kmutex_t *mutexes)
{
    process_t *p = &g_procs[g_proc_count++];
    p->pid = pid; p->name = name;
    p->thread_list = threads; p->sem_list = sems; p->mutex_list = mutexes;
    p->next = NULL;
    return p;
}

static bnode_t *bst_insert(bnode_t *root, int key, const char *label)
{
    if (!root) {
        bnode_t *n = &g_bnodes[g_bnode_count++];
        n->key = key; set_tag(n->label, label); n->left = NULL; n->right = NULL;
        return n;
    }
    if (key < root->key) root->left  = bst_insert(root->left,  key, label);
    else                 root->right = bst_insert(root->right, key, label);
    return root;
}

/* Breakpoint'i buraya koy. printf yerine gozlemlenebilir bir yan etki. */
static volatile unsigned g_sink;
static void inspect_point(int tick)
{
    g_sink = (unsigned)(tick + g_thread_count + g_sem_count + g_mutex_count + g_timer_count);
}

/* 0x4000=16384 stack'in kullanim yuzdesi (usage bar: yesil/yesil/sari/kirmizi) */
static const unsigned long STACK_USED[4] = { 0x1000, 0x2a00, 0x3300, 0x3d00 }; /* 25/65/80/95% */

int main(void)
{
    /* ---- process'ler + her birinin thread/sem alt listeleri (gruplu ağaç) ---- */
    process_t *prevp = NULL;
    for (int p = 0; p < N_PROC; p++) {
        tcb_t *thead = NULL, *tprev = NULL;
        for (int i = 0; i < TPP; i++) {
            int gid = p * TPP + i;
            tcb_t *t = mk_thread(gid + 1, NAMES[gid % NN], (thread_state_t)(gid % 4), gid % 10);
            t->stack_used = STACK_USED[gid % 4];
            if (!thead) thead = t;
            if (tprev) tprev->next = t;
            tprev = t;
        }
        ksem_t *shead = NULL, *sprev = NULL;
        for (int i = 0; i < SPP; i++) {
            int gid = p * SPP + i;
            ksem_t *s = mk_sem(gid + 1, gid % 5, 5, gid % 3, (sem_discipline_t)(gid % 2));
            if (!shead) shead = s;
            if (sprev) sprev->next = s;
            sprev = s;
        }
        process_t *proc = mk_proc(p + 1, PNAMES[p % NPN], thead, shead, NULL);
        proc->slot_head = p * SLOT_BLK;            /* her process'in slot bloğu */
        if (prevp) prevp->next = proc; else g_process_list = proc;
        prevp = proc;
    }

    /* ---- düz mutex tablosu (yüzlerce); kimi kilitli + owner geçerli bir thread id (link örneği) ---- */
    for (int i = 0; i < MAX_MUTEXES; i++) {
        int locked = (i % 3 == 0);
        int owner  = locked ? ((i % MAX_THREADS) + 1) : 0;   /* threads'e link için geçerli id */
        mk_mutex(i + 1, NAMES[i % NN], owner, locked, locked ? (i % 4) : 0);
    }

    /* ---- timer dizisi (yüzlerce) ---- */
    for (int i = 0; i < MAX_TIMERS; i++)
        mk_timer(i + 1, NAMES[i % NN], (i + 1) * 10, i % 7, i % 2);

    /* ---- widget havuzu (yüzlerce, cast dizisi); ilk 3 anlamlı (slots/boxes wrap örnekleri) ---- */
    for (int i = 0; i < MAX_WIDGETS; i++) {
        g_widget_pool[i].x = 10 + i;
        g_widget_pool[i].y = 20 + i * 2;
        g_widget_pool[i].label = NAMES[i % NN];
    }
    g_widget_pool[0].label = "button";
    g_widget_pool[1].label = "slider";
    g_widget_pool[2].label = "label";
    g_widgets.data = g_widget_pool;
    g_widgets.size = MAX_WIDGETS;
    g_slots[0] = &g_widget_pool[0];
    g_slots[1] = &g_widget_pool[1];
    g_slots[2] = &g_widget_pool[2];
    g_boxes[0].data = &g_widget_pool[0]; g_boxes[0].kind = 1;
    g_boxes[1].data = &g_widget_pool[1]; g_boxes[1].kind = 1;
    g_boxes[2].data = &g_widget_pool[2]; g_boxes[2].kind = 2;

    /* ---- index-linked havuz: process başına bir blok, her blok kendi içinde zincir (-1 ile biter) ---- */
    for (int p = 0; p < N_PROC; p++) {
        for (int i = 0; i < SLOT_BLK; i++) {
            int idx = p * SLOT_BLK + i;
            g_slot_pool[idx].id   = 100 + idx;
            g_slot_pool[idx].name = NAMES[idx % NN];
            set_tag(g_slot_pool[idx].tag, NAMES[idx % NN]);
            g_slot_pool[idx].next = (i == SLOT_BLK - 1) ? -1 : (idx + 1);
        }
    }
    g_slot_head = 0;   /* global 'pool' sekmesi blok 0'ı gösterir; procSlots her bloğu */

    /* eski pool kökü de geçerli kalsın */
    g_pool0.thread_list = g_process_list->thread_list;
    g_pool0.sem_list    = g_process_list->sem_list;
    g_pool0.mutex_list  = &g_mutexes[0];
    g_kernel.pools[0]   = &g_pool0;
    g_kernel.pools[1]   = NULL;

    /* binary search tree (tree mode demo) */
    {
        int bk[7] = { 50, 30, 70, 20, 40, 60, 80 };
        const char *bl[7] = { "root", "l", "r", "ll", "lr", "rl", "rr" };
        g_tree_root = NULL;
        for (int i = 0; i < 7; i++) g_tree_root = bst_insert(g_tree_root, bk[i], bl[i]);
    }

    for (int tick = 0; tick < 3; tick++) {
        g_threads[1].state  = (tick % 2) ? RUNNING : READY;   /* değişiklik-vurgusu örneği */
        g_mutexes[0].locked = (tick % 2);
        g_mutexes[0].owner  = (tick % 2) ? 4 : 0;
        g_timers[0].elapsed = tick;
        g_widget_pool[0].x  = 10 + tick;
        inspect_point(tick);
    }
    return 0;
}
