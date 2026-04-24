package com.pipelinesync;

// ═══════════════════════════════════════════════════════════════════════════════
//  PipelineSync — Spring Boot Backend (single-file architecture)
//  Handles: WebHooks → Kafka → Redis Pub/Sub → WebSocket → PostgreSQL
// ═══════════════════════════════════════════════════════════════════════════════

import com.fasterxml.jackson.annotation.JsonIgnoreProperties;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import jakarta.persistence.*;
import lombok.*;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.boot.SpringApplication;
import org.springframework.boot.autoconfigure.SpringBootApplication;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.data.redis.connection.RedisConnectionFactory;
import org.springframework.data.redis.core.StringRedisTemplate;
import org.springframework.data.redis.listener.*;
import org.springframework.http.*;
import org.springframework.kafka.annotation.KafkaListener;
import org.springframework.kafka.core.KafkaTemplate;
import org.springframework.messaging.handler.annotation.*;
import org.springframework.messaging.simp.SimpMessagingTemplate;
import org.springframework.messaging.simp.config.MessageBrokerRegistry;
import org.springframework.scheduling.annotation.EnableAsync;
import org.springframework.stereotype.*;
import org.springframework.web.bind.annotation.*;
import org.springframework.web.socket.config.annotation.*;
import org.springframework.web.reactive.function.client.WebClient;
import reactor.core.publisher.Mono;

import javax.crypto.Mac;
import javax.crypto.spec.SecretKeySpec;
import java.nio.charset.StandardCharsets;
import java.time.Instant;
import java.util.*;

// ─── Application Entry Point ──────────────────────────────────────────────────
@SpringBootApplication
@EnableAsync
public class PipelineSyncApplication {
    public static void main(String[] args) {
        SpringApplication.run(PipelineSyncApplication.class, args);
    }
}

// ─── WebSocket Configuration ──────────────────────────────────────────────────
@Configuration
@EnableWebSocketMessageBroker
class WebSocketConfig implements WebSocketMessageBrokerConfigurer {
    @Override
    public void configureMessageBroker(MessageBrokerRegistry config) {
        config.enableSimpleBroker("/topic");
        config.setApplicationDestinationPrefixes("/app");
    }

    @Override
    public void registerStompEndpoints(StompEndpointRegistry registry) {
        registry.addEndpoint("/ws")
                .setAllowedOriginPatterns("*")
                .withSockJS();
    }
}

// ─── CORS Configuration ───────────────────────────────────────────────────────
@Configuration
class CorsConfig {
    @Bean
    org.springframework.web.filter.CorsFilter corsFilter() {
        var config = new org.springframework.web.cors.CorsConfiguration();
        config.setAllowedOriginPatterns(List.of("*"));
        config.setAllowedMethods(List.of("GET", "POST", "PUT", "DELETE", "OPTIONS"));
        config.setAllowedHeaders(List.of("*"));
        config.setAllowCredentials(true);
        var source = new org.springframework.web.cors.UrlBasedCorsConfigurationSource();
        source.registerCorsConfiguration("/**", config);
        return new org.springframework.web.filter.CorsFilter(source);
    }
}

// ─── Redis Pub/Sub Configuration ──────────────────────────────────────────────
@Configuration
class RedisConfig {
    @Bean
    RedisMessageListenerContainer redisContainer(
            RedisConnectionFactory factory,
            PipelineEventBroadcaster broadcaster) {
        var container = new RedisMessageListenerContainer();
        container.setConnectionFactory(factory);
        container.addMessageListener(broadcaster, new PatternTopic("pipeline:*"));
        return container;
    }
}

// ─── JPA Entities ─────────────────────────────────────────────────────────────
@Entity @Table(name = "pipeline_runs") @Data @NoArgsConstructor @AllArgsConstructor @Builder
class PipelineRun {
    @Id @GeneratedValue(strategy = GenerationType.IDENTITY)
    private Long id;
    private String repo;
    private String branch;
    private String commitSha;
    private String commitMessage;
    private String author;
    private String runId;          // GitHub Actions run ID
    private String status;         // queued, in_progress, completed
    private String conclusion;     // success, failure, cancelled, null
    private Instant triggeredAt;
    private Instant updatedAt;
}

@Entity @Table(name = "annotations") @Data @NoArgsConstructor @AllArgsConstructor @Builder
class Annotation {
    @Id @GeneratedValue(strategy = GenerationType.IDENTITY)
    private Long id;
    private Long pipelineRunId;
    private String jobName;        // which CI job/step
    private String author;
    private String content;
    private String type;           // comment, warning, error, info
    private boolean resolved;
    private Long parentId;         // for threading
    @Version
    private Long version;          // optimistic locking
    private Instant createdAt;
    private Instant updatedAt;
}

// ─── Repositories ─────────────────────────────────────────────────────────────
interface PipelineRunRepository extends JpaRepository<PipelineRun, Long> {
    List<PipelineRun> findByRepoOrderByTriggeredAtDesc(String repo);
    Optional<PipelineRun> findByRunId(String runId);
}

interface AnnotationRepository extends JpaRepository<Annotation, Long> {
    List<Annotation> findByPipelineRunIdOrderByCreatedAtAsc(Long pipelineRunId);
}

// ─── DTOs ─────────────────────────────────────────────────────────────────────
record AnnotationRequest(String jobName, String author, String content, String type, Long parentId) {}
record PipelineEvent(String type, Object payload) {}

// ─── GitHub Webhook Controller ────────────────────────────────────────────────
@RestController
@RequestMapping("/webhook")
@RequiredArgsConstructor
class WebhookController {
    private final KafkaTemplate<String, String> kafka;
    private final ObjectMapper mapper;

    @Value("${github.webhook-secret}")
    private String webhookSecret;

    @PostMapping("/github")
    ResponseEntity<String> handleWebhook(
            @RequestHeader(value = "X-GitHub-Event", defaultValue = "") String event,
            @RequestHeader(value = "X-Hub-Signature-256", defaultValue = "") String sig,
            @RequestBody String body) throws Exception {

        if (!webhookSecret.isBlank() && !verifySignature(body, sig)) {
            return ResponseEntity.status(HttpStatus.UNAUTHORIZED).body("Invalid signature");
        }

        if ("workflow_run".equals(event) || "workflow_job".equals(event) || "check_run".equals(event)) {
            kafka.send("github-pipeline-events", event, body);
        }

        return ResponseEntity.ok("ok");
    }

    private boolean verifySignature(String body, String sig) throws Exception {
        Mac mac = Mac.getInstance("HmacSHA256");
        mac.init(new SecretKeySpec(webhookSecret.getBytes(StandardCharsets.UTF_8), "HmacSHA256"));
        byte[] hash = mac.doFinal(body.getBytes(StandardCharsets.UTF_8));
        String expected = "sha256=" + HexFormat.of().formatHex(hash);
        return expected.equals(sig);
    }
}

// ─── Kafka Consumer → Parse → Redis Pub/Sub ───────────────────────────────────
@Component
@RequiredArgsConstructor
class PipelineEventConsumer {
    private final PipelineRunRepository runs;
    private final StringRedisTemplate redis;
    private final ObjectMapper mapper;

    @KafkaListener(topics = "github-pipeline-events", groupId = "pipelinesync-group")
    void consume(
            @org.springframework.kafka.support.KafkaHeaders.ReceivedKey String event,
            @Payload String body) throws Exception {

        JsonNode root = mapper.readTree(body);

        if ("workflow_run".equals(event)) {
            JsonNode wr = root.path("workflow_run");
            String runId = wr.path("id").asText();
            String status = wr.path("status").asText();
            String conclusion = wr.path("conclusion").asText(null);
            String repo = root.path("repository").path("full_name").asText();
            String branch = wr.path("head_branch").asText();
            String sha = wr.path("head_sha").asText();
            String author = wr.path("triggering_actor").path("login").asText();
            String msg = wr.path("head_commit").path("message").asText();

            PipelineRun run = runs.findByRunId(runId).orElse(
                PipelineRun.builder().runId(runId).repo(repo).branch(branch)
                    .commitSha(sha).commitMessage(msg).author(author)
                    .triggeredAt(Instant.now()).build()
            );
            run.setStatus(status);
            run.setConclusion(conclusion);
            run.setUpdatedAt(Instant.now());
            runs.save(run);

            // Fan out via Redis Pub/Sub
            redis.convertAndSend("pipeline:" + repo,
                mapper.writeValueAsString(Map.of("type", "PIPELINE_UPDATE", "payload", run)));
        }
    }
}

// ─── Redis → WebSocket Broadcaster ───────────────────────────────────────────
@Component
@RequiredArgsConstructor
class PipelineEventBroadcaster implements MessageListener {
    private final SimpMessagingTemplate ws;
    private final ObjectMapper mapper;

    @Override
    public void onMessage(org.springframework.data.redis.connection.Message message, byte[] pattern) {
        try {
            String channel = new String(message.getChannel());
            String repo = channel.replace("pipeline:", "");
            String body = new String(message.getBody());
            ws.convertAndSend("/topic/pipeline/" + repo.replace("/", "_"), body);
        } catch (Exception e) {
            // log
        }
    }
}

// ─── REST API Controllers ─────────────────────────────────────────────────────
@RestController
@RequestMapping("/api")
@RequiredArgsConstructor
class ApiController {
    private final PipelineRunRepository runs;
    private final AnnotationRepository annotations;
    private final SimpMessagingTemplate ws;
    private final ObjectMapper mapper;

    // Repos — list recent repos seen
    @GetMapping("/repos")
    List<String> repos() {
        return runs.findAll().stream()
            .map(PipelineRun::getRepo)
            .distinct()
            .sorted()
            .toList();
    }

    // Pipeline runs for a repo
    @GetMapping("/pipelines")
    List<PipelineRun> pipelines(@RequestParam String repo) {
        return runs.findByRepoOrderByTriggeredAtDesc(repo);
    }

    // Simulate a pipeline run (for demo without real GitHub)
    @PostMapping("/pipelines/simulate")
    PipelineRun simulate(@RequestBody Map<String, String> body) {
        String repo = body.getOrDefault("repo", "demo/app");
        PipelineRun run = PipelineRun.builder()
            .runId(UUID.randomUUID().toString())
            .repo(repo)
            .branch(body.getOrDefault("branch", "main"))
            .commitSha(UUID.randomUUID().toString().substring(0, 7))
            .commitMessage(body.getOrDefault("message", "feat: add new feature"))
            .author(body.getOrDefault("author", "dev"))
            .status("in_progress")
            .triggeredAt(Instant.now())
            .updatedAt(Instant.now())
            .build();
        return runs.save(run);
    }

    // Annotations CRUD
    @GetMapping("/pipelines/{id}/annotations")
    List<Annotation> getAnnotations(@PathVariable Long id) {
        return annotations.findByPipelineRunIdOrderByCreatedAtAsc(id);
    }

    @PostMapping("/pipelines/{id}/annotations")
    Annotation addAnnotation(@PathVariable Long id, @RequestBody AnnotationRequest req) {
        Annotation a = Annotation.builder()
            .pipelineRunId(id)
            .jobName(req.jobName())
            .author(req.author())
            .content(req.content())
            .type(req.type() != null ? req.type() : "comment")
            .resolved(false)
            .parentId(req.parentId())
            .createdAt(Instant.now())
            .updatedAt(Instant.now())
            .build();
        Annotation saved = annotations.save(a);

        // Broadcast new annotation via WebSocket
        runs.findById(id).ifPresent(run -> {
            try {
                String topic = "/topic/pipeline/" + run.getRepo().replace("/", "_");
                ws.convertAndSend(topic, mapper.writeValueAsString(
                    Map.of("type", "ANNOTATION", "payload", saved)));
            } catch (Exception ignored) {}
        });
        return saved;
    }

    @PatchMapping("/annotations/{id}/resolve")
    Annotation resolve(@PathVariable Long id) {
        Annotation a = annotations.findById(id).orElseThrow();
        a.setResolved(!a.isResolved());
        a.setUpdatedAt(Instant.now());
        return annotations.save(a);
    }

    // GitHub API proxy — fetch workflow runs for a repo
    @GetMapping("/github/runs")
    Mono<String> githubRuns(
            @RequestParam String repo,
            @Value("${github.token}") String token) {
        WebClient client = WebClient.builder()
            .baseUrl("https://api.github.com")
            .defaultHeader("Authorization", "Bearer " + token)
            .defaultHeader("Accept", "application/vnd.github+json")
            .build();

        return client.get()
            .uri("/repos/{repo}/actions/runs?per_page=20", repo)
            .retrieve()
            .bodyToMono(String.class);
    }

    // GitHub API proxy — fetch jobs for a run
    @GetMapping("/github/runs/{runId}/jobs")
    Mono<String> githubJobs(
            @PathVariable String runId,
            @RequestParam String repo,
            @Value("${github.token}") String token) {
        WebClient client = WebClient.builder()
            .baseUrl("https://api.github.com")
            .defaultHeader("Authorization", "Bearer " + token)
            .defaultHeader("Accept", "application/vnd.github+json")
            .build();

        return client.get()
            .uri("/repos/{repo}/actions/runs/{runId}/jobs", repo, runId)
            .retrieve()
            .bodyToMono(String.class);
    }
}

// ─── WebSocket Message Handler (annotation from WS) ──────────────────────────
@Controller
@RequiredArgsConstructor
class WsAnnotationController {
    private final AnnotationRepository annotations;
    private final SimpMessagingTemplate ws;

    @MessageMapping("/annotate/{pipelineId}")
    @SendTo("/topic/annotations/{pipelineId}")
    Annotation annotateViaWs(@DestinationVariable Long pipelineId,
                              @Payload AnnotationRequest req) {
        return annotations.save(Annotation.builder()
            .pipelineRunId(pipelineId)
            .jobName(req.jobName())
            .author(req.author())
            .content(req.content())
            .type(req.type() != null ? req.type() : "comment")
            .resolved(false)
            .parentId(req.parentId())
            .createdAt(Instant.now())
            .updatedAt(Instant.now())
            .build());
    }
}
